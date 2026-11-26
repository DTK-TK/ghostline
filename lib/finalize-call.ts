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

import { updateCall, getCallEvents } from "@/lib/db";
import type { CallRow, CallState, CallOutcome } from "@/lib/db";
import { sendAlerts } from "@/lib/alerts";
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

  const level = call.risk_level;
  if (level !== "medium" && level !== "high") return;

  try {
    const events = await getCallEvents(call.id);
    const attempts = events.filter((e) => e.type === "safe_word_attempt");
    const lastAttempt = attempts[attempts.length - 1];
    const callback = events
      .filter((e) => e.type === "callback_result")
      .map((e) => e.payload["outcome"])
      .pop();

    await sendAlerts({
      call,
      level,
      claimedIdentity: call.claimed_identity,
      requestedAmount: null,
      paymentMethod: null,
      safeWordResult: !lastAttempt ? "not asked" : lastAttempt.payload["matched"] === true ? "passed" : "failed",
      callbackResult:
        callback === "denied" || callback === "confirmed" || callback === "no_answer"
          ? callback
          : "not initiated",
    });

    if (level === "high") await buildAndStoreReport(call.id);
  } catch (err) {
    console.error("[finalize-call] alert or report failed:", err instanceof Error ? err.message : "unknown");
  }
}
