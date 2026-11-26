/**
 * POST /api/voice/status
 *
 * Twilio StatusCallback webhook — fired when a call leg reaches a terminal
 * status (completed, busy, failed, no-answer, canceled).
 *
 * Responsibilities:
 *  1. Validate Twilio signature.
 *  2. Set calls.state = "completed" (or "failed") and calls.ended_at = now.
 *  3. Set calls.outcome if not already set by the turn handler.
 *  4. Respond 204 — Twilio ignores the body of status callbacks.
 *
 * This route must NOT return TwiML; it returns an empty 204.
 * On error it returns 500 — Twilio will retry status callbacks.
 */

import { validateTwilioRequest } from "@/lib/twilio-validate";
import { getCallBySid, updateCall } from "@/lib/db";
import type { CallState, CallOutcome } from "@/lib/db";

export const runtime = "nodejs";

/** Twilio CallStatus values → our internal state/outcome mappings. */
const STATUS_MAP: Record<string, { state: CallState; outcome: CallOutcome }> = {
  completed:  { state: "completed", outcome: "transferred" },
  busy:       { state: "completed", outcome: "dropped" },
  failed:     { state: "failed",    outcome: "unknown" },
  "no-answer":{ state: "completed", outcome: "dropped" },
  canceled:   { state: "completed", outcome: "dropped" },
};

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;

  try {
    params = await validateTwilioRequest(req);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const callSid    = params["CallSid"]    ?? "";
    const callStatus = params["CallStatus"] ?? "completed";

    const existing = await getCallBySid(callSid);
    if (!existing) {
      // Unknown SID — trusted-contact calls don't all create DB rows; ignore.
      return new Response(null, { status: 204 });
    }

    const mapping = STATUS_MAP[callStatus] ?? STATUS_MAP["completed"];

    // Only overwrite outcome if the turn handler hasn't already set one
    // (e.g. scam_blocked or time_wasted already wrote a meaningful outcome).
    const patch: Parameters<typeof updateCall>[1] = {
      state: mapping.state,
      ended_at: new Date().toISOString(),
    };
    if (!existing.outcome) {
      patch.outcome = mapping.outcome;
    }

    await updateCall(callSid, patch);

    return new Response(null, { status: 204 });
  } catch {
    return new Response("Internal Server Error", { status: 500 });
  }
}
