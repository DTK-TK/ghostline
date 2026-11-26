/**
 * lib/time-waster.ts
 *
 * Pure helpers for the time-waster persona: limit, timer, scripted lines,
 * duration summary and the shared HIGH-risk transition. No I/O.
 */

import type { CallEventRow, CallOutcome, CallState } from "@/lib/db";

export const MAX_SECONDS = 180;

// ---- Scripted lines (each under 20 words, at most 2 sentences) -------------

export const ENTRY_LINE = "Oh my, hold on dear, I can't find my glasses.";

export const GRANDMOTHER_LINES: readonly string[] = [
  "Now where did I put that? Marmalade, get off the phone table!",
  "Could you speak up a little? I'm a bit hard of hearing.",
  "I'm sorry, what was that? I was just feeding the cat.",
  "One moment, I need to sit down. My hip is acting up today.",
];

export const GOODBYE_LINE = "Oh dear, I must go feed Marmalade. Goodbye!";

// ---- Limit -----------------------------------------------------------------

/** Seconds the persona may run. Env is read on every call so tests can stub it. */
export function limitSeconds(): number {
  const raw = process.env.TIME_WASTER_SECONDS;
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_SECONDS) : MAX_SECONDS;
}

// ---- Timer -----------------------------------------------------------------

type EventLike = Pick<CallEventRow, "type" | "payload" | "created_at">;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isEntry(e: EventLike): boolean {
  return e.type === "state_change" && e.payload["to"] === "time_wasted";
}

function lastEntryIndex(events: readonly EventLike[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isEntry(events[i]!)) return i;
  }
  return -1;
}

/**
 * Start of the latest time_wasted stretch: payload.started_at (app clock),
 * else the event's created_at. Null when the call never entered the persona.
 */
export function startedAtFrom(events: readonly EventLike[]): string | null {
  const idx = lastEntryIndex(events);
  if (idx < 0) return null;
  const e = events[idx]!;
  return str(e.payload["started_at"]) ?? e.created_at;
}

/** Whole seconds from the persona start to `now`. 0 when there is no start. */
export function elapsedSeconds(events: readonly EventLike[], now: Date): number {
  const startedAt = startedAtFrom(events);
  if (!startedAt) return 0;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((now.getTime() - start) / 1000));
}

export interface TimeWastedSummary {
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  running: boolean;
}

/** Duration for the dashboard. Null when the persona never started. */
export function timeWastedSummary(
  events: readonly EventLike[],
  now: Date,
): TimeWastedSummary | null {
  const idx = lastEntryIndex(events);
  if (idx < 0) return null;
  const startedAt = startedAtFrom(events)!;

  const exit = events
    .slice(idx + 1)
    .find((e) => e.type === "state_change" && e.payload["from"] === "time_wasted");
  const endedAt = exit ? (str(exit.payload["ended_at"]) ?? exit.created_at) : null;

  const startMs = Date.parse(startedAt);
  const endMs = endedAt ? Date.parse(endedAt) : now.getTime();
  const seconds = Number.isNaN(startMs) || Number.isNaN(endMs)
    ? 0
    : Math.max(0, Math.floor((endMs - startMs) / 1000));

  return { startedAt, endedAt, seconds, running: endedAt === null };
}

/** Seconds to show now: counts up from startedAt while running, else the final value. */
export function displaySeconds(summary: TimeWastedSummary, nowMs: number): number {
  if (!summary.running) return summary.seconds;
  const start = Date.parse(summary.startedAt);
  return Number.isNaN(start) ? summary.seconds : Math.max(0, Math.floor((nowMs - start) / 1000));
}

export interface TimeWastedView extends TimeWastedSummary {
  limitSeconds: number;
}

/** Summary plus the configured limit, for the dev phone. Null before the persona starts. */
export function timeWastedView(
  events: readonly EventLike[],
  now: Date,
): TimeWastedView | null {
  const summary = timeWastedSummary(events, now);
  return summary ? { ...summary, limitSeconds: limitSeconds() } : null;
}

/** 180 -> "03:00". */
export function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ---- Shared HIGH transition ------------------------------------------------

export interface HighRiskResult {
  state: CallState;
  extra: Record<string, unknown>;
  outcome?: CallOutcome;
  hangup?: boolean;
}

const NO_CHANGE_STATES: readonly CallState[] = [
  "time_wasted",
  "scam_blocked",
  "completed",
  "failed",
];

/**
 * What a HIGH-risk call becomes. Persona on: time_wasted with started_at.
 * Persona off: a plain block. A call already in a terminal or persona state
 * keeps its state and adds nothing.
 */
export function enterHighRisk(args: {
  call: { state: CallState };
  household: { time_waster_enabled: boolean };
  now: Date;
}): HighRiskResult {
  const { call, household, now } = args;
  if (NO_CHANGE_STATES.includes(call.state)) {
    return { state: call.state, extra: {} };
  }
  if (household.time_waster_enabled) {
    return { state: "time_wasted", extra: { started_at: now.toISOString() } };
  }
  return { state: "scam_blocked", extra: {}, outcome: "blocked", hangup: true };
}
