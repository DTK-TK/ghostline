/**
 * POST /api/voice/status
 *
 * Twilio StatusCallback webhook, fired when a call leg reaches a terminal
 * status (completed, busy, failed, no-answer, canceled).
 *
 * Thin adapter: validates the Twilio signature and delegates to
 * handleCallStatus() (lib/voice-status.ts). Responds 204 with no body.
 * On error it returns 500 so Twilio retries the status callback.
 */

import { validateTwilioRequest } from "@/lib/twilio-validate";
import { handleCallStatus } from "@/lib/voice-status";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;

  try {
    params = await validateTwilioRequest(req);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    // Unknown SIDs (trusted-contact calls have no row) are ignored.
    await handleCallStatus(params["CallSid"] ?? "", params["CallStatus"] ?? "completed");
    return new Response(null, { status: 204 });
  } catch {
    return new Response("Internal Server Error", { status: 500 });
  }
}
