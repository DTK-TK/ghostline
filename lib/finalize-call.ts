/**
 * lib/finalize-call.ts
 *
 * finalizeCall(): the end of a call. Sets state, ended_at and outcome, then
 * alerts the family (MEDIUM and HIGH) and stores the fraud report (HIGH).
 * Used by the status webhook and the simulator.
 *
 * Alerts and reports are idempotent and best-effort: a failed SMS or report
 * never fails the call update (Twilio would retry the webhook).
 */

import { updateCall } from "@/lib/db";
import type { CallRow, CallState, CallOutcome } from "@/lib/db";
import { alertCall } from "@/lib/alert-call";
import { buildAndStoreReport } from "@/lib/report";

export interface FinalizeInput {
  state: CallState;
  /** Used only when the call has no outcome yet. */
  outcome: CallOutcome;
}

export async function finalizeCall(call: CallRow, end: FinalizeInput): Promise<void> {
  const patch: Parameters<typeof updateCall>[1] = {
    state: end.state,
    ended_at: new Date().toISOString(),
  };
  // Keep an outcome the turn handler already set (e.g. blocked).
  if (!call.outcome) patch.outcome = end.outcome;

  await updateCall(call.call_sid, patch);

  // Both are best effort and idempotent. alertCall should not throw, but a
  // failure here must never fail the webhook (Twilio would retry it).
  try {
    await alertCall(call.id);
  } catch (err) {
    console.error("[finalize-call] alert failed:", err instanceof Error ? err.name : "error");
  }

  if (call.risk_level === "high" || call.risk_level === "critical") {
    try {
      await buildAndStoreReport(call.id);
    } catch (err) {
      console.error("[finalize-call] report failed:", err instanceof Error ? err.message : "unknown");
    }
  }
}