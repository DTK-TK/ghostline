/**
 * POST /api/dev/phone/turn
 *
 * Dev-only adapter. Runs one spoken turn for the browser phone through the
 * same processTurn() as /api/voice/turn, and returns JSON.
 *
 * Returns 404 unless devToolsEnabled() (lib/dev-gate.ts).
 *
 * Body: { callSid: string; speechResult: string }
 * Response: { reply, state, riskScore, riskLevel, flags, hangup, timeWasted?, callbackPending: boolean,
 *   callbackTarget? (masked, e.g. "family member (***4567)") }
 * time_wasted is not terminal: the persona keeps replying until the engine
 * ends the call (state "completed", hangup true).
 */

import { devToolsEnabled, devToolsNotFound } from "@/lib/dev-gate";
import { getCallEvents } from "@/lib/db";
import type { CallEventRow } from "@/lib/db";
import { processTurn } from "@/lib/turn";
import { timeWastedView } from "@/lib/time-waster";
import { maskPhone } from "@/lib/phone";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!devToolsEnabled()) return devToolsNotFound();

  try {
    const body = await req.json() as { callSid?: string; speechResult?: string };
    const callSid = (body.callSid ?? "").trim();

    if (!callSid) {
      return Response.json({ error: "callSid is required" }, { status: 400 });
    }

    const result = await processTurn({
      callSid,
      speech: body.speechResult ?? "",
      source: "dev",
    });
    if (result.kind === "not_found") {
      return Response.json({ error: `Call not found: ${callSid}` }, { status: 404 });
    }

    // Current flags and pending callback for the debug panel.
    const events = await getCallEvents(result.call.id);
    const flags = events
      .filter((e) => e.type === "red_flag")
      .map((e) => (typeof e.payload["flag"] === "string" ? e.payload["flag"] : ""))
      .filter(Boolean);
    const callbackPending = detectPendingCallback(events);
    const timeWasted = timeWastedView(events, new Date());

    return Response.json({
      reply: result.reply,
      state: result.nextState,
      riskScore: result.riskScore,
      riskLevel: result.riskLevel,
      flags,
      hangup: result.hangup === true,
      ...(timeWasted ? { timeWasted } : {}),
      callbackPending: callbackPending !== null,
      ...(callbackPending ? { callbackTarget: callbackPending } : {}),
    });
  } catch (err) {
    console.error("[dev/phone/turn] error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
/**
 * Returns a masked label for the callback target if a callback was started
 * but not yet resolved, otherwise null. Never returns a full number.
 */
function detectPendingCallback(events: CallEventRow[]): string | null {
  const started = events.filter((e) => e.type === "callback_started");
  const results = events.filter((e) => e.type === "callback_result");
  if (started.length <= results.length) return null;

  const last = started[started.length - 1]!;
  const target = typeof last.payload["target_phone"] === "string" ? last.payload["target_phone"] : "";
  return target ? `family member (${maskPhone(target)})` : "family member";
}
