/**
 * POST /api/voice/callback
 *
 * Twilio calls this when the family member answers the callback call that
 * Ghostline placed (TwilioTelephony.startCallbackCall). Plays the prompt and
 * waits for one digit, which goes to /api/voice/callback-result.
 *
 * Query: originalCallSid (the screening call), claimedName (sanitised in lib).
 * Signature validated; any error returns a plain hangup.
 */
import { validateTwilioRequest, twimlResponse } from "@/lib/twilio-validate";
import { hangupTwiml } from "@/lib/twiml";
import { buildCallbackPrompt } from "@/lib/callback";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    await validateTwilioRequest(req);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const query = new URL(req.url).searchParams;
    const xml = await buildCallbackPrompt({
      originalCallSid: query.get("originalCallSid") ?? "",
      claimedName: query.get("claimedName"),
      baseUrl: process.env.PUBLIC_BASE_URL ?? "",
    });
    return twimlResponse(xml);
  } catch {
    return twimlResponse(hangupTwiml());
  }
}
