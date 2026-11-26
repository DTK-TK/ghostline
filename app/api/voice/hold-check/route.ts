/**
 * POST /api/voice/hold-check?n=1..4
 *
 * The caller-side hold loop. While the family member's phone rings, the turn
 * route sends the caller here (Pause 10, then Redirect). Each pass either waits
 * again, gives up after four passes (about 45 s), or moves on with the result.
 * Signature validated; logic in lib/callback.ts; any error returns safe TwiML.
 */
import { validateTwilioRequest, twimlResponse } from "@/lib/twilio-validate";
import { errorFallbackTwiml } from "@/lib/twiml";
import { handleHoldCheck } from "@/lib/callback";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;
  try {
    params = await validateTwilioRequest(req);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const xml = await handleHoldCheck({
      callSid: params["CallSid"] ?? "",
      n: new URL(req.url).searchParams.get("n"),
      baseUrl: process.env.PUBLIC_BASE_URL ?? "",
    });
    return twimlResponse(xml ?? errorFallbackTwiml());
  } catch {
    return twimlResponse(errorFallbackTwiml());
  }
}
