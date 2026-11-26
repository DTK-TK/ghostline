/**
 * lib/time-waster-exit.ts
 *
 * Writes the time-waster exit event for the two exits that happen outside the
 * engine: the caller hangs up (status webhook) and the caller goes silent
 * (turn). The limit exit is written by the turn flow from engine output.
 *
 * Exactly once: nothing is written when the latest persona stretch already
 * has an exit event.
 */

import { appendEvent, getCallEvents } from "@/lib/db";
import type { CallOutcome } from "@/lib/db";
import { startedAtFrom, timeWastedSummary } from "@/lib/time-waster";

export type ExitReason = "caller_hung_up" | "caller_silent";

export interface TimeWastedExit {
  outcome: CallOutcome;
  endedAt: string;
}

/**
 * Append state_change time_wasted -> completed with started_at, ended_at,
 * seconds and reason. Returns null when the exit was already recorded.
 * The caller must only use this when the stored state was time_wasted.
 */
export async function recordTimeWastedExit(args: {
  callId: string;
  reason: ExitReason;
  now?: Date;
}): Promise<TimeWastedExit | null> {
  const now = args.now ?? new Date();
  const events = await getCallEvents(args.callId);

  const summary = timeWastedSummary(events, now);
  if (summary && !summary.running) return null;

  const endedAt = now.toISOString();
  const startedAt = startedAtFrom(events) ?? endedAt;
  const seconds = summary ? summary.seconds : 0;

  await appendEvent({
    call_id: args.callId,
    type: "state_change",
    payload: {
      type: "state_change",
      from: "time_wasted",
      to: "completed",
      started_at: startedAt,
      ended_at: endedAt,
      seconds,
      reason: args.reason,
    },
  });

  return { outcome: "time_wasted", endedAt };
}
