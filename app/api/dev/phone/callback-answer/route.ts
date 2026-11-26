/**
 * POST /api/dev/phone/callback-answer
 *
 * Dev-only. Simulates the family member answering the callback call and
 * pressing a DTMF digit. The digits match the spoken prompt
 * ("Press 1 if you are safe and NOT calling. Press 2 if it really is you."):
 * 1 = denied, 2 = confirmed, 0 = no answer.
 *
 * Runs the same code as /api/voice/callback-result (recordCallbackResult in
 * lib/callback.ts): first result wins, confirmed lowers the score by 40,
 * denied goes on the HIGH path (time-waster or blocked) and sends the alert.
 *
 * Returns 404 unless devToolsEnabled() (lib/dev-gate.ts).
 *
 * Body: { callSid: string; digit: "1" | "2" | "0" }
 * Response: {
 *   outcome: "confirmed" | "denied" | "no_answer";
 *   recorded: boolean;
 *   riskScore: number;
 *   riskLevel: string;
 *   state: string;
 * }
 */

import { recordCallbackResult } from "@/lib/callback";
import type { CallbackOutcome } from "@/lib/callback";
import { getCallBySid } from "@/lib/db";
import { devToolsEnabled, devToolsNotFound } from "@/lib/dev-gate";

export const runtime = "nodejs";

const DIGIT_OUTCOME: Record<string, CallbackOutcome> = {
  "1": "denied",
  "2": "confirmed",
  "0": "no_answer",
};

export async function POST(req: Request): Promise<Response> {
  if (!devToolsEnabled()) return devToolsNotFound();

  try {
    const body = (await req.json()) as { callSid?: string; digit?: string };
    const callSid = (body.callSid ?? "").trim();
    const digit = (body.digit ?? "0").trim();

    if (!callSid) {
      return Response.json({ error: "callSid is required" }, { status: 400 });
    }

    const outcome = DIGIT_OUTCOME[digit] ?? "no_answer";

    const call = await getCallBySid(callSid);
    if (!call) {
      return Response.json({ error: `Call not found: ${callSid}` }, { status: 404 });
    }

    const result = await recordCallbackResult(callSid, outcome);
    const current = result.call ?? call;

    return Response.json({
      outcome,
      recorded: result.recorded,
      riskScore: result.score ?? current.risk_score ?? 0,
      riskLevel: result.level ?? current.risk_level ?? "low",
      state: result.state ?? current.state,
    });
  } catch (err) {
    console.error("[dev/phone/callback-answer] error:", err instanceof Error ? err.message : "unknown");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
