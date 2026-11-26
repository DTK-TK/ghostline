/**
 * lib/safe-word-phase.ts
 *
 * Challenge-phase detection and fixed lines for the safe-word flow.
 * The phase is derived from call_events (the last system transcript), never
 * from memory. No line here depends on the attempt or the safe word.
 */

import type { CallEventRow } from "@/lib/db";

export const SAFE_WORD_CHALLENGE = "What's the family word?";
export const SAFE_WORD_RETRY = "Sorry, I didn't catch that. What's the family word?";
/** Stored as the caller transcript for an attempt turn. */
export const SAFE_WORD_TRANSCRIPT = "[safe word attempt]";
export const SAFE_WORD_REDACTED = "[redacted]";
/** Safe word attempts allowed per call. */
export const MAX_SAFE_WORD_ATTEMPTS = 2;

export const VERIFIED_REPLY = "Thank you. One moment while I connect you.";
export const BLOCKED_REPLY = "I'm not able to connect this call. Goodbye.";
export const TIME_WASTER_REPLY =
  "Oh dear, hold on, I can't find my glasses. Now, who did you say you were?";

export function isChallengeLine(text: unknown): boolean {
  return text === SAFE_WORD_CHALLENGE || text === SAFE_WORD_RETRY;
}

/**
 * True when the next caller turn is a safe word attempt: the last system
 * transcript is the challenge (or retry) line, no attempt has matched, and
 * fewer than MAX_SAFE_WORD_ATTEMPTS attempts were made.
 */
export function inChallengePhase(events: CallEventRow[]): boolean {
  const attempts = events.filter((e) => e.type === "safe_word_attempt");
  if (attempts.length >= MAX_SAFE_WORD_ATTEMPTS) return false;
  if (attempts.some((e) => e.payload["matched"] === true)) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "transcript" && e.payload["speaker"] === "system") {
      return isChallengeLine(e.payload["text"]);
    }
  }
  return false;
}
