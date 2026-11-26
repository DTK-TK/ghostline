/**
 * POST /api/dev/phone/callback-answer
 *
 * Dev-only. Simulates the family member answering the callback call and
 * pressing a DTMF digit (1 = confirmed / it's me, 2 = denied / not me,
 * 0 = no answer).
 *
 * Replicates what /api/voice/callback/result would do in production.
 *
 * Returns 404 when VERCEL_ENV === "production".
 *
 * Body: { callId: string; digit: "1" | "2" | "0" }
 * Response: {
 *   outcome: "confirmed" | "denied" | "no_answer";
 *   riskScore: number;
 *   riskLevel: string;
 *   state: string;
 * }
 */

import { notFound } from "next/navigation";
import {
  getCallBySid,
  appendEvent,
  updateCall,
} from "@/lib/db";
import { combineScores } from "@/lib/scoring/combine";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (process.env.VERCEL_ENV === "production") notFound();

  try {
    const body = await req.json() as { callSid?: string; digit?: string };
    const callSid = (body.callSid ?? "").trim();
    const digit = (body.digit ?? "0").trim();

    if (!callSid) {
      return Response.json({ error: "callSid is required" }, { status: 400 });
    }

    const call = await getCallBySid(callSid);
    if (!call) {
      return Response.json({ error: `Call not found: ${callSid}` }, { status: 404 });
    }

    let outcome: "confirmed" | "denied" | "no_answer";
    let newScore = call.risk_score ?? 0;
    let nextState = call.state;

    if (digit === "2") {
      // Family member denied — apply +100 callback_denied penalty.
      outcome = "denied";

      const combined = combineScores({
        rulesScore: 0,
        aiScore: 0,
        allFlags: [],
        safeWordCorrect: false,
        callbackDenied: true,
        priorScore: call.risk_score ?? 0,
      });

      newScore = combined.score;

      await appendEvent({
        call_id: call.id,
        type: "callback_result",
        payload: { type: "callback_result", outcome: "denied" },
      });

      nextState = "scam_blocked";

      await updateCall(callSid, {
        state: nextState,
        risk_score: newScore,
        risk_level: combined.level,
      });
    } else if (digit === "1") {
      // Family member confirmed — no score change.
      outcome = "confirmed";

      await appendEvent({
        call_id: call.id,
        type: "callback_result",
        payload: { type: "callback_result", outcome: "confirmed" },
      });

      // State stays in screening — the next /turn call will move to verified
      // once the conversation engine processes the safe-word (or low risk).
    } else {
      // No answer.
      outcome = "no_answer";

      await appendEvent({
        call_id: call.id,
        type: "callback_result",
        payload: { type: "callback_result", outcome: "no_answer" },
      });
    }

    return Response.json({
      outcome,
      riskScore: newScore,
      riskLevel: call.risk_level ?? "low",
      state: nextState,
    });
  } catch (err) {
    console.error("[dev/phone/callback-answer] error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
