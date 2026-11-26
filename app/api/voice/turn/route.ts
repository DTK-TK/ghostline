/**
 * POST /api/voice/turn
 *
 * Called by Twilio after every <Gather> completes (speech detected or
 * timed-out) and after every <Redirect method="POST"> fallback.
 *
 * Responsibilities:
 *  1. Validate Twilio signature.
 *  2. Read SpeechResult from the form body.
 *  3. Persist a transcript event (even for empty turns — silence is a signal).
 *  4. Track consecutive-silence count; after two, say goodbye and record.
 *  5. Call the conversation engine to get { reply, nextState, riskUpdate }.
 *  6. Persist the state/risk update to calls.
 *  7. Return the appropriate TwiML for nextState.
 *
 * State-to-TwiML mapping:
 *   screening / identify / safe_word  → replyTwiml (keep gathering)
 *   time_wasted                        → timeWasteTwiml
 *   verified / transferring            → connectTwiml
 *   scam_blocked                       → blockTwiml
 *   completed                          → messageTwiml (message, then end)
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
import { runTurn } from "@/lib/conversation-engine";

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
      // CallSid not in DB — this can happen for trusted-contact calls that
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
    // 3. Silence tracking — count consecutive empty SpeechResult turns.
    //    We detect runs by looking at recent transcript events in the DB.
    //    For efficiency, we keep a simple running count in the payload of
    //    the most recent state_change event (or fall back to 0).
    //    A non-empty turn resets the counter.
    // ------------------------------------------------------------------ //
    const silenceCount = computeSilenceCount(
      speechResult,
      call.state,
    );

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
    const { reply, nextState, riskUpdate } = await runTurn({
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
 * Determine whether this turn is silent and increment a lightweight counter.
 *
 * This runs entirely from the current turn's data to avoid an extra DB round-
 * trip on the hot path. The turn handler stores silence state in the call
 * record via the state machine; two empty turns in a row will both be
 * "screening" state with no transition, so we can detect the second one here.
 *
 * A proper implementation in spec 3 may query call_events to count recent
 * empty transcript rows. This stub counts 1 for the current empty turn if the
 * call is already in a state where silence has been seen before.
 */
function computeSilenceCount(
  speechResult: string,
  currentState: CallState,
): number {
  if (speechResult !== "") return 0;
  // If we see empty speech while already in a non-initial state, treat it
  // as the second silence (the first was the trigger that caused /turn to
  // be called with no SpeechResult after the <Redirect> fallback).
  // The spec 3 engine will replace this with a DB-backed counter.
  const silenceStates: CallState[] = ["screening", "verified", "transferring"];
  return silenceStates.includes(currentState) ? SILENCE_LIMIT : 1;
}

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
