/**
 * lib/live-format.ts
 *
 * Pure text helpers for the Live page. No I/O, no clock: `now` is passed in.
 */

import type { CallRow } from "@/lib/db";
import type { CallbackStatus, SafeWordStatus } from "@/lib/live-status";

/** 125 -> "02:05". Minutes keep growing past 59 ("75:00"). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Never mentions the word or the attempts' text, only counts. */
export function safeWordText(status: SafeWordStatus, attempts: number): string {
  switch (status) {
    case "not_asked":
      return "Not asked";
    case "asked":
      return "Asked, waiting for the answer";
    case "passed":
      return "Passed";
    case "failed":
      return `Failed (${Math.min(Math.max(attempts, 0), 2)} of 2 attempts)`;
  }
}

export function callbackText(status: CallbackStatus, target: string | null): string {
  switch (status) {
    case "not_initiated":
      return "Not started";
    case "calling":
      return target ? `Calling family member ${target}` : "Calling a family member";
    case "pending":
      return "Waiting for the family member's answer";
    case "confirmed":
      return "Confirmed by the family member";
    case "denied":
      return "Family member says it is not them";
    case "no_answer":
      return "No answer";
  }
}

const STATE_TEXT: Record<CallRow["state"], string> = {
  initiated: "Call started",
  screening: "Screening the caller",
  verified: "Caller verified",
  transferring: "Connecting to the family",
  scam_blocked: "Call not connected",
  time_wasted: "Keeping the caller busy",
  completed: "Call ended",
  failed: "Call failed",
};

export function stateText(state: CallRow["state"]): string {
  return STATE_TEXT[state] ?? state;
}

export interface ConnectionView {
  label: string;
  ok: boolean;
}

/** "Live, updated 3 s ago" / "Reconnecting..." / "Connecting...". */
export function connectionView(lastUpdated: Date | null, reconnecting: boolean, now: number): ConnectionView {
  if (reconnecting) return { label: "Reconnecting...", ok: false };
  if (!lastUpdated) return { label: "Connecting...", ok: false };
  const ago = Math.max(0, Math.floor((now - lastUpdated.getTime()) / 1000));
  return { label: `Live, updated ${ago} s ago`, ok: true };
}

/** True when the scroller is within `threshold` px of the bottom. */
export function isNearBottom(
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 24,
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}
