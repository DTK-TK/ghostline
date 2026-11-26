/**
 * lib/live-status.ts
 *
 * Pure view-model for the Live page. No I/O, no clock: `now` is passed in.
 *
 * NOTE: `lib/call-evidence.ts` (alerts-and-report) and `timeWastedSummary`
 * (time-waster, `lib/time-waster.ts`) do not exist yet, so the small
 * equivalents below are local. Swap them for the shared helpers when those
 * land; the exported shape does not change.
 *
 * Safe word attempt text is never read. Only the `matched` boolean is used.
 */

import type { CallEventRow, CallRow } from "@/lib/db";
import { KNOWN_FLAG_IDS } from "@/lib/scoring/known-flags";

export type LiveLevel = "low" | "medium" | "high";
export type SafeWordStatus = "not_asked" | "asked" | "passed" | "failed";
export type CallbackStatus =
  | "not_initiated"
  | "calling"
  | "pending"
  | "confirmed"
  | "denied"
  | "no_answer";

export interface LiveFlag {
  id: string;
  label: string;
  quote: string;
}

export interface LiveTimeWasted {
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  running: boolean;
}

export interface LiveTranscriptLine {
  id: string;
  speaker: "caller" | "ghostline";
  text: string;
  at: string;
}

export interface LiveStatus {
  level: LiveLevel;
  score: number;
  flags: LiveFlag[];
  safeWord: SafeWordStatus;
  attempts: number;
  callback: CallbackStatus;
  /** Masked target such as "•••• 1234", or null. */
  callbackTarget: string | null;
  timeWasted: LiveTimeWasted | null;
  transcript: LiveTranscriptLine[];
  state: CallRow["state"];
  simulated: boolean;
}

/** A callback_started with no result is "calling" for this long, then "pending". */
export const CALLING_WINDOW_MS = 10_000;
const QUOTE_MAX = 140;

const FLAG_LABELS: Record<string, string> = {
  payment_method: "Unusual payment method",
  secrecy: "Asks for secrecy",
  authority: "Claims to be an authority",
  emergency_story: "Emergency story",
  urgency: "Pressure to act now",
  remote_access: "Wants remote access",
  safe_word_fail: "Wrong or refused safe word",
  callback_denied: "Family says they are not calling",
};

const KNOWN = new Set<string>(KNOWN_FLAG_IDS);

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function levelFor(call: CallRow, score: number): LiveLevel {
  if (call.risk_level === "critical") return "high";
  if (call.risk_level) return call.risk_level;
  return score >= 70 ? "high" : score >= 40 ? "medium" : "low";
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `\u2022\u2022\u2022\u2022 ${digits.slice(-4)}` : "\u2022\u2022\u2022\u2022";
}

function truncate(text: string): string {
  const t = text.trim();
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1)}\u2026` : t;
}

function deriveTimeWasted(
  call: CallRow,
  events: CallEventRow[],
  now: number,
): LiveTimeWasted | null {
  let startIdx = -1;
  events.forEach((e, i) => {
    if (e.type === "state_change" && e.payload["to"] === "time_wasted") startIdx = i;
  });
  if (startIdx < 0) return null;

  const start = events[startIdx]!;
  const startedAt = str(start.payload["started_at"]) ?? start.created_at;

  const exit = events
    .slice(startIdx + 1)
    .find((e) => e.type === "state_change" && e.payload["from"] === "time_wasted");

  const endedAt = exit
    ? (str(exit.payload["ended_at"]) ?? exit.created_at)
    : call.ended_at;

  const endMs = endedAt ? ms(endedAt) : now;
  const seconds = Math.max(0, Math.floor((endMs - ms(startedAt)) / 1000));
  return { startedAt, endedAt: endedAt ?? null, seconds, running: !endedAt };
}

function deriveSafeWord(events: CallEventRow[]): { status: SafeWordStatus; attempts: number } {
  const attempts = events.filter((e) => e.type === "safe_word_attempt");
  if (attempts.some((e) => e.payload["matched"] === true)) {
    return { status: "passed", attempts: attempts.length };
  }
  if (attempts.length > 0) return { status: "failed", attempts: attempts.length };

  // Asked: Ghostline has said "safe word" (or "secret word") but no attempt is stored yet.
  const asked = events.some(
    (e) =>
      e.type === "transcript" &&
      e.payload["speaker"] === "system" &&
      /\b(safe|secret)\s+word\b/i.test(str(e.payload["text"]) ?? ""),
  );
  return { status: asked ? "asked" : "not_asked", attempts: 0 };
}

function deriveCallback(
  events: CallEventRow[],
  now: number,
): { status: CallbackStatus; target: string | null } {
  const started = events.filter((e) => e.type === "callback_started");
  const results = events.filter((e) => e.type === "callback_result");
  const lastStart = started[started.length - 1];
  const target = maskPhone(str(lastStart?.payload["target_phone"]));

  if (results.length >= started.length && results.length > 0) {
    const outcome = results[results.length - 1]!.payload["outcome"];
    if (outcome === "denied" || outcome === "confirmed" || outcome === "no_answer") {
      return { status: outcome, target };
    }
  }
  if (lastStart) {
    const age = now - ms(lastStart.created_at);
    return { status: age < CALLING_WINDOW_MS ? "calling" : "pending", target };
  }
  return { status: "not_initiated", target: null };
}

export function deriveLiveStatus(
  call: CallRow,
  events: CallEventRow[],
  now: number,
): LiveStatus {
  const sorted = [...events].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const score = call.risk_score ?? 0;

  // Transcript, plus the caller line most recently heard (the quote source).
  const transcript: LiveTranscriptLine[] = [];
  const flags: LiveFlag[] = [];
  const seen = new Set<string>();
  let lastCallerText = "";

  for (const e of sorted) {
    if (e.type === "transcript") {
      const text = str(e.payload["text"]) ?? "";
      const speaker = e.payload["speaker"] === "system" ? "ghostline" : "caller";
      if (text.trim() === "") continue;
      transcript.push({ id: e.id, speaker, text, at: e.created_at });
      if (speaker === "caller") lastCallerText = text;
    } else if (e.type === "red_flag") {
      const id = str(e.payload["flag"]);
      if (!id || !KNOWN.has(id) || seen.has(id)) continue;
      seen.add(id);
      const fromCaller = id !== "safe_word_fail" && id !== "callback_denied";
      flags.push({
        id,
        label: FLAG_LABELS[id] ?? id,
        quote: fromCaller ? truncate(lastCallerText) : "",
      });
    }
  }

  const safe = deriveSafeWord(sorted);
  const cb = deriveCallback(sorted, now);

  return {
    level: levelFor(call, score),
    score,
    flags,
    safeWord: safe.status,
    attempts: safe.attempts,
    callback: cb.status,
    callbackTarget: cb.target,
    timeWasted: deriveTimeWasted(call, sorted, now),
    transcript,
    state: call.state,
    simulated: call.is_simulated,
  };
}
