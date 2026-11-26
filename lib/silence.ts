import { getCallEvents } from "@/lib/db";

/**
 * Count consecutive empty caller transcripts at the end of a call's events.
 *
 * The turn route stores the current caller turn (even when empty) before
 * calling this, so the current empty turn is already included in the count.
 * Non-transcript events and system replies are skipped. The first non-empty
 * caller transcript, walking backwards, ends the run.
 */
export async function countConsecutiveSilence(callId: string): Promise<number> {
  const events = await getCallEvents(callId);
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "transcript") continue;
    const payload = e.payload as { speaker?: unknown; text?: unknown };
    if (payload.speaker !== "caller") continue;
    if (typeof payload.text === "string" && payload.text.trim() === "") count++;
    else break;
  }
  return count;
}
