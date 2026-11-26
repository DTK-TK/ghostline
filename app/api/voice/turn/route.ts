/**
 * POST /api/voice/turn
 *
 * Called by Twilio after every <Gather> completes (speech detected or
 * timed-out) and after every <Redirect method="POST"> fallback.
 *
 * Responsibilities:
 *  1. Validate Twilio signature.
 *  2. Read SpeechResult from the form body.
 *  3. Persist a transcript event (even for empty turns —silence is a signal).
 *  4. Track consecutive-silence count; after two, say goodbye and record.
 *  5. Call the conversation engine to get { reply, nextState, riskUpdate }.
 *  6. Persist the state/risk update to calls.
 *  7. Return the appropriate TwiML for nextState.
 *
 * State-to-TwiML mapping:
 *   screening / identify / safe_word  —replyTwiml (keep gathering)
 *   time_wasted                        —timeWasteTwiml
 *   verified / transferring            —connectTwiml
 *   scam_blocked                       —blockTwiml
 *   completed                          —messageTwiml (message, then end)
 *
 * Must answer within 10 s. Catches all errors and returns errorFallbackTwiml.
 */

import { validateTwilioRequest, twimlResponse } from "@/lib/twilio-validate";
import {
  replyTwiml,
  connectTwiml,
  blockTwiml,
  messageTwiml,
  timeWasteTwiml,
  silenceGoodbyeTwiml,
  errorFallbackTwiml,
} from "@/lib/twiml";
import {
  getCallBySid,
  getHousehold,
  updateCall,
  appendEvent,
} from "@/lib/db";
import type { CallState } from "@/lib/db";
import { engine } from "@/lib/conversation";
import { countConsecutiveSilence } from "@/lib/silence";

export const runtime = "nodejs";

/** Number of consecutive silent turns before giving up and recording. */
const SILENCE_LIMIT = 2;

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;

  try {
    params = await validateTwilioRequest(req);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const callSid = params["CallSid"] ?? "";
    const speechResult = (params["SpeechResult"] ?? "").trim();

    const baseUrl = process.env.PUBLIC_BASE_URL ?? "";

    // ------------------------------------------------------------------ //
    // 1. Load current call record
    // ------------------------------------------------------------------ //
    const call = await getCallBySid(callSid);
    if (!call) {
      // CallSid not in DB —this can happen for trusted-contact calls that
      // hit /turn via a misconfigured webhook. Fail safe.
      return twimlResponse(errorFallbackTwiml());
    }

    const household = await getHousehold(call.household_id);
    if (!household) {
      return twimlResponse(errorFallbackTwiml());
    }

    const twilioNumber = process.env.TWILIO_PHONE_NUMBER ?? params["To"] ?? "";

    // ------------------------------------------------------------------ //
    // 2. Persist transcript event (empty string = silence)
    // ------------------------------------------------------------------ //
    await appendEvent({
      call_id: call.id,
      type: "transcript",
      payload: { type: "transcript", text: speechResult, speaker: "caller" },
    });

    // ------------------------------------------------------------------ //
    // 3. Silence tracking: count consecutive empty caller transcripts in
    //    call_events (current turn already stored above). Hang up at the limit.
    //    A non-empty turn resets the count.
    // ------------------------------------------------------------------ //
    const silenceCount = speechResult === "" ? await countConsecutiveSilence(call.id) : 0;

    if (silenceCount >= SILENCE_LIMIT) {
      await updateCall(callSid, { state: "completed", outcome: "dropped" });
      await appendEvent({
        call_id: call.id,
        type: "state_change",
        payload: { type: "state_change", from: call.state, to: "completed" as CallState },
      });
      return twimlResponse(silenceGoodbyeTwiml());
    }

    // ------------------------------------------------------------------ //
    // 4. Run conversation engine
    // ------------------------------------------------------------------ //
    const { reply, nextState, riskUpdate } = await engine({
      callSid,
      speechResult,
      currentState: call.state,
      currentRiskScore: call.risk_score ?? 0,
    });

    // ------------------------------------------------------------------ //
    // 5. Persist state transition and risk update
    // ------------------------------------------------------------------ //
    if (nextState !== call.state) {
      await appendEvent({
        call_id: call.id,
        type: "state_change",
        payload: { type: "state_change", from: call.state, to: nextState },
      });
    }

    await updateCall(callSid, {
      state: nextState,
      risk_score: Math.max(riskUpdate.score, call.risk_score ?? 0),
      risk_level: riskUpdate.level,
    });

    // ------------------------------------------------------------------ //
    // 6. Build TwiML for nextState
    // ------------------------------------------------------------------ //
    return twimlResponse(
      buildTwiml(nextState, reply, baseUrl, household.senior_phone, twilioNumber),
    );
  } catch {
    return twimlResponse(errorFallbackTwiml());
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a call state to the correct TwiML response.
 * Terminal states (scam_blocked, completed, time_wasted) do not re-gather.
 */
function buildTwiml(
  state: CallState,
  reply: string,
  baseUrl: string,
  seniorPhone: string,
  twilioNumber: string,
): string {
  switch (state) {
    case "verified":
    case "transferring":
      return connectTwiml(seniorPhone, twilioNumber);

    case "scam_blocked":
      return blockTwiml();

    case "completed":
      return messageTwiml();

    case "time_wasted":
      return timeWasteTwiml(reply, baseUrl);

    // All screening states: continue the conversation.
    case "initiated":
    case "screening":
    case "failed":
    default:
      return replyTwiml(reply, baseUrl);
  }
}
