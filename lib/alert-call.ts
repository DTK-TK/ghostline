/**
 * lib/alert-call.ts
 *
 * alertCall(callId): the one entry point that alerts the family about a call.
 * It loads the call from the database, builds the alert context from stored
 * data, and calls sendAlerts().
 *
 *   HIGH    sent immediately.
 *   MEDIUM  sent when a message was taken (opts.messageTaken) or the call has
 *           ended. Before that it does nothing.
 *   LOW     nothing.
 *
 * Every trigger calls this same function. Sending is once per
 * (call, alert type, recipient) inside sendAlerts(), so repeats are harmless.
 * Best effort: it never throws into the voice path. Errors are logged without
 * phone numbers or message bodies.
 */

import { getCallById, getCallEvents } from "@/lib/db";
import type { CallEventRow, CallRow } from "@/lib/db";
import { sendAlerts } from "@/lib/alerts";
import type { AlertContext } from "@/lib/alerts";

export interface AlertCallOptions {
  /** A MEDIUM caller left a message: alert now instead of at call end. */
  messageTaken?: boolean;
}

const ENDED_STATES = ["completed", "scam_blocked", "verified", "transferring"];

function hasEnded(call: CallRow): boolean {
  return call.ended_at !== null || ENDED_STATES.includes(call.state);
}

function safeWordResult(events: CallEventRow[]): AlertContext["safeWordResult"] {
  const attempts = events.filter((e) => e.type === "safe_word_attempt");
  const last = attempts[attempts.length - 1];
  if (!last) return "not asked";
  return last.payload["matched"] === true ? "passed" : "failed";
}

function callbackResult(events: CallEventRow[]): AlertContext["callbackResult"] {
  const outcome = events
    .filter((e) => e.type === "callback_result")
    .map((e) => e.payload["outcome"])
    .pop();
  if (outcome === "denied" || outcome === "confirmed" || outcome === "no_answer") return outcome;
  return events.some((e) => e.type === "callback_started") ? "pending" : "not initiated";
}

export async function alertCall(callId: string, opts: AlertCallOptions = {}): Promise<void> {
  try {
    const call = await getCallById(callId);
    if (!call) return;

    // "critical" is reported as HIGH.
    const level = call.risk_level === "critical" ? "high" : call.risk_level;
    if (level !== "medium" && level !== "high") return;
    if (level === "medium" && !opts.messageTaken && !hasEnded(call)) return;

    const events = await getCallEvents(callId);
    await sendAlerts({
      call,
      level,
      claimedIdentity: call.claimed_identity,
      requestedAmount: call.requested_amount,
      paymentMethod: call.payment_method,
      safeWordResult: safeWordResult(events),
      callbackResult: callbackResult(events),
    });
  } catch (err) {
    // Never log numbers or SMS bodies.
    console.error("[alert-call] failed:", err instanceof Error ? err.name : "error");
  }
}
