/**
 * lib/voice-status.ts
 *
 * Business logic of the Twilio status webhook. Reads the stored call first:
 * if the persona was active, the exit event is written and the outcome is
 * time_wasted instead of transferred.
 */

import { getCallBySid } from "@/lib/db";
import type { CallState, CallOutcome } from "@/lib/db";
import { finalizeCall } from "@/lib/finalize-call";
import { recordTimeWastedExit } from "@/lib/time-waster-exit";

/** Twilio CallStatus values mapped to our internal state and outcome. */
const STATUS_MAP: Record<string, { state: CallState; outcome: CallOutcome }> = {
  completed:   { state: "completed", outcome: "transferred" },
  busy:        { state: "completed", outcome: "dropped" },
  failed:      { state: "failed",    outcome: "unknown" },
  "no-answer": { state: "completed", outcome: "dropped" },
  canceled:    { state: "completed", outcome: "dropped" },
};

/** Returns false when the CallSid is unknown (nothing to update). */
export async function handleCallStatus(callSid: string, callStatus: string): Promise<boolean> {
  const existing = await getCallBySid(callSid);
  if (!existing) return false;

  let mapping = STATUS_MAP[callStatus] ?? STATUS_MAP["completed"]!;

  // Read the stored state before it is overwritten.
  if (existing.state === "time_wasted" && mapping.state === "completed") {
    await recordTimeWastedExit({ callId: existing.id, reason: "caller_hung_up" });
    mapping = { state: "completed", outcome: "time_wasted" };
  }

  await finalizeCall(existing, mapping);
  return true;
}
