/**
 * POST /api/dev/phone/turn
 *
 * Dev-only. Processes one spoken turn for the browser phone, calling the
 * same conversation engine as /api/voice/turn without Twilio plumbing.
 *
 * Returns 404 when VERCEL_ENV === "production".
 *
 * Body: { callSid: string; speechResult: string }
 * Response: {
 *   reply: string;
 *   state: string;
 *   riskScore: number;
 *   riskLevel: string;
 *   flags: string[];
 *   callbackPending?: { name: string; phone: string; callSid: string };
 * }
 */

import { notFound } from "next/navigation";
import {
  getCallBySid,
  getCallEvents,
  appendEvent,
  updateCall,
} from "@/lib/db";
import type { CallState, CallEventRow } from "@/lib/db";
import { engine } from "@/lib/conversation";

export const runtime = "nodejs";

/** Terminal states that should not accept more turns. */
const TERMINAL: CallState[] = ["scam_blocked", "completed", "verified", "transferring", "time_wasted"];

export async function POST(req: Request): Promise<Response> {
  if (process.env.VERCEL_ENV === "production") notFound();

  try {
    const body = await req.json() as { callSid?: string; speechResult?: string };
    const callSid = (body.callSid ?? "").trim();
    const speechResult = (body.speechResult ?? "").trim();

    if (!callSid) {
      return Response.json({ error: "callSid is required" }, { status: 400 });
    }

    const call = await getCallBySid(callSid);
    if (!call) {
      return Response.json({ error: `Call not found: ${callSid}` }, { status: 404 });
    }

    // Persist transcript event (mirrors /api/voice/turn behaviour).
    await appendEvent({
      call_id: call.id,
      type: "transcript",
      payload: { type: "transcript", text: speechResult, speaker: "caller" },
    });

    // If the call is already terminal, just echo the state back.
    if (TERMINAL.includes(call.state)) {
      const events = await getCallEvents(call.id);
      const flags = events
        .filter((e) => e.type === "red_flag")
        .map((e) => (typeof e.payload["flag"] === "string" ? e.payload["flag"] : ""))
        .filter(Boolean);

      return Response.json({
        reply: terminalReply(call.state),
        state: call.state,
        riskScore: call.risk_score ?? 0,
        riskLevel: call.risk_level ?? "low",
        flags,
      });
    }

    // Run the conversation engine.
    const { reply, nextState, riskUpdate } = await engine({
      callSid,
      speechResult,
      currentState: call.state,
      currentRiskScore: call.risk_score ?? 0,
    });

    // Append state_change event if state transitioned.
    if (nextState !== call.state) {
      await appendEvent({
        call_id: call.id,
        type: "state_change",
        payload: { type: "state_change", from: call.state, to: nextState },
      });
    }

    await updateCall(callSid, {
      state: nextState,
      risk_score: Math.max(riskUpdate.score, call.risk_score ?? 0),
      risk_level: riskUpdate.level,
    });

    // Collect current flags for the debug panel.
    const events = await getCallEvents(call.id);
    const flags = events
      .filter((e) => e.type === "red_flag")
      .map((e) => (typeof e.payload["flag"] === "string" ? e.payload["flag"] : ""))
      .filter(Boolean);

    // Check for a pending callback (callback_started event with no matching callback_result).
    const callbackPending = detectPendingCallback(events, call.id);

    return Response.json({
      reply,
      state: nextState,
      riskScore: Math.max(riskUpdate.score, call.risk_score ?? 0),
      riskLevel: riskUpdate.level,
      flags,
      ...(callbackPending ? { callbackPending } : {}),
    });
  } catch (err) {
    console.error("[dev/phone/turn] error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

function terminalReply(state: CallState): string {
  switch (state) {
    case "verified":
    case "transferring":
      return "You have been connected to the resident. Have a good day!";
    case "scam_blocked":
      return "I'm not able to connect this call. Goodbye.";
    case "time_wasted":
      return "Oh dear, I must go feed Marmalade. Goodbye!";
    case "completed":
      return "This call has ended.";
    default:
      return "This call has ended.";
  }
}

/** Returns the pending callback info if a callback was started but not yet resolved. */
function detectPendingCallback(
  events: CallEventRow[],
  _callId: string,
): { name: string; phone: string; originalCallSid: string } | null {
  const started = events.filter((e) => e.type === "callback_started");
  const results = events.filter((e) => e.type === "callback_result");

  // If we have more starts than results, the latest callback is pending.
  if (started.length > results.length) {
    const last = started[started.length - 1]!;
    const targetPhone =
      typeof last.payload["target_phone"] === "string" ? last.payload["target_phone"] : "";
    const name = targetPhone ? `family member (${targetPhone.slice(-4)})` : "family member";
    return {
      name,
      phone: targetPhone,
      originalCallSid: _callId,
    };
  }

  return null;
}
