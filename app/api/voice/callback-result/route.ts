/**
 * POST /api/voice/callback-result?originalCallSid=..
 *
 * Receives the family member's answer to the callback call: the Gather digit
 * (1 = not me, denied; 2 = it is me, confirmed) and the call's status callback
 * (no answer, busy, failed, canceled, completed without a digit = no_answer).
 * The first result wins. Signature validated; logic in lib/callback.ts; any
 * error returns a plain hangup.
 */
import { validateTwilioRequest, twimlResponse } from "@/lib/twilio-validate";
import { hangupTwiml } from "@/lib/twiml";
import { handleCallbackResult } from "@/lib/callback";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;
  try {
    params = await validateTwilioRequest(req);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const query = new URL(req.url).searchParams;
    const xml = await handleCallbackResult({
      originalCallSid: query.get("originalCallSid") ?? "",
      claimedName: query.get("claimedName"),
      retry: query.get("retry") === "1",
      digits: params["Digits"],
      callStatus: params["CallStatus"],
      baseUrl: process.env.PUBLIC_BASE_URL ?? "",
    });
    return twimlResponse(xml);
  } catch {
    return twimlResponse(hangupTwiml());
  }
}
