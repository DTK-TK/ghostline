/**
 * POST /api/voice/incoming
 *
 * First webhook Twilio hits when a call arrives on the Ghostline number.
 *
 * Fast path  — From is a trusted contact → <Dial> senior immediately.
 * Screen path — unknown caller → create calls row, speak opening line,
 *               open <Gather> pointing at /api/voice/turn.
 *
 * Must respond within 10 seconds (Twilio hard timeout).
 * On any error: return errorFallbackTwiml() so the caller never hears silence.
 */

import { validateTwilioRequest, twimlResponse } from "@/lib/twilio-validate";
import { errorFallbackTwiml, greetingTwiml, connectTwiml } from "@/lib/twiml";
import {
  getHouseholdByPhone,
  isTrustedContact,
  createCall,
} from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string>;

  try {
    params = await validateTwilioRequest(req);
  } catch {
    // Reject invalid signatures with 403, no TwiML body needed.
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const callSid = params["CallSid"] ?? "";
    const from = params["From"] ?? "";
    const to = params["To"] ?? "";

    const baseUrl = process.env.PUBLIC_BASE_URL ?? "";
    const twilioNumber = process.env.TWILIO_PHONE_NUMBER ?? to;

    // Look up the household by the Twilio number that was dialled.
    const household = await getHouseholdByPhone(to);
    if (!household) {
      // No household configured for this number — take a message silently.
      return twimlResponse(errorFallbackTwiml());
    }

    // Trusted contact? Ring straight through, no screening.
    const trusted = await isTrustedContact(household.id, from);
    if (trusted) {
      await createCall({
        household_id: household.id,
        call_sid: callSid,
        from_number: from,
        state: "completed",
        outcome: "transferred",
      });
      return twimlResponse(connectTwiml(household.senior_phone, twilioNumber));
    }

    // Unknown caller — create call record and start the screening flow.
    await createCall({
      household_id: household.id,
      call_sid: callSid,
      from_number: from,
      state: "screening",
    });

    return twimlResponse(greetingTwiml(household.family_name, baseUrl));
  } catch {
    return twimlResponse(errorFallbackTwiml());
  }
}
