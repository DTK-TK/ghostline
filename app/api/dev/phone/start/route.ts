/**
 * POST /api/dev/phone/start
 *
 * Dev-only. Creates a calls row and returns the initial Ghostline greeting,
 * replicating the logic of /api/voice/incoming without Twilio signature
 * validation or TwiML.
 *
 * Returns 404 when VERCEL_ENV === "production".
 *
 * Body: { fromNumber: string, householdPhone: string }
 * Response: { callSid: string; callId: string; reply: string; state: string }
 */

import { notFound } from "next/navigation";
import {
  getHouseholdByPhone,
  isTrustedContact,
  createCall,
} from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (process.env.VERCEL_ENV === "production") notFound();

  try {
    const body = await req.json() as { fromNumber?: string; householdPhone?: string };
    const fromNumber = (body.fromNumber ?? "").trim();
    const householdPhone = (body.householdPhone ?? "").trim();

    if (!fromNumber || !householdPhone) {
      return Response.json(
        { error: "fromNumber and householdPhone are required" },
        { status: 400 },
      );
    }

    const household = await getHouseholdByPhone(householdPhone);
    if (!household) {
      return Response.json(
        { error: `No household found for phone ${householdPhone}` },
        { status: 404 },
      );
    }

    const trusted = await isTrustedContact(household.id, fromNumber);

    // Generate a fake CallSid that is locally unique and clearly not real.
    const callSid = `DEV_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    if (trusted) {
      await createCall({
        household_id: household.id,
        call_sid: callSid,
        from_number: fromNumber,
        state: "completed",
        outcome: "transferred",
      });

      return Response.json({
        callSid,
        callId: null,     // will be re-read on first turn
        reply: `Trusted contact recognised. Connecting directly to the ${household.family_name} residence.`,
        state: "completed",
        trusted: true,
      });
    }

    const call = await createCall({
      household_id: household.id,
      call_sid: callSid,
      from_number: fromNumber,
      state: "screening",
    });

    const greeting =
      `You've reached the ${household.family_name} residence. ` +
      "This call is screened by Ghostline. " +
      "Please say your name and why you're calling.";

    return Response.json({
      callSid,
      callId: call.id,
      reply: greeting,
      state: "screening",
      trusted: false,
    });
  } catch (err) {
    console.error("[dev/phone/start] error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
