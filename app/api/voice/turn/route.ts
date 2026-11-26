/**
 * POST /api/voice/turn
 *
 * Twilio webhook after every <Gather> or <Redirect>. Thin adapter: validates
 * the signature, passes the speech to processTurn() (lib/turn.ts) and maps
 * the resulting state to TwiML. Any error returns errorFallbackTwiml.
 *
 * State-to-TwiML mapping:
 *   screening / initiated  replyTwiml (keep gathering)
 *   time_wasted            timeWasteTwiml
 *   verified / transferring connectTwiml
 *   scam_blocked           blockTwiml
 *   completed              messageTwiml (message, then end)
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
import type { CallState } from "@/lib/db";
import { processTurn } from "@/lib/turn";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;

  try {
    params = await validateTwilioRequest(req);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const result = await processTurn({
      callSid: params["CallSid"] ?? "",
      speech: params["SpeechResult"] ?? "",
      source: "twilio",
    });

    // Unknown CallSid or household: fail safe.
    if (result.kind === "not_found") return twimlResponse(errorFallbackTwiml());
    if (result.silenceHangup) return twimlResponse(silenceGoodbyeTwiml());

    const baseUrl = process.env.PUBLIC_BASE_URL ?? "";
    const twilioNumber = process.env.TWILIO_PHONE_NUMBER ?? params["To"] ?? "";

    return twimlResponse(
      buildTwiml(result.nextState, result.reply, baseUrl, result.household.senior_phone, twilioNumber),
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
