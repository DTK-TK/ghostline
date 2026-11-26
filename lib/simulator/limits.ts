/**
 * lib/simulator/limits.ts
 *
 * Pure rate-limit rule: one run per household per 30 s, at most 50 in the
 * last 24 hours. `startedAt` holds the started_at of the household's simulated
 * calls (ISO strings, any order).
 */

export const MIN_GAP_MS = 30_000;
export const DAILY_CAP = 50;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type LimitResult = { ok: true } | { ok: false; reason: "too_soon" | "daily_cap"; retryAfterSeconds: number };

export function checkLimits(startedAt: string[], now: Date): LimitResult {
  const times = startedAt.map((s) => Date.parse(s)).filter((t) => Number.isFinite(t));
  const newest = times.length ? Math.max(...times) : null;
  if (newest !== null && now.getTime() - newest < MIN_GAP_MS) {
    return { ok: false, reason: "too_soon", retryAfterSeconds: Math.ceil((MIN_GAP_MS - (now.getTime() - newest)) / 1000) };
  }
  const recent = times.filter((t) => now.getTime() - t < DAY_MS);
  if (recent.length >= DAILY_CAP) {
    const oldest = Math.min(...recent);
    return { ok: false, reason: "daily_cap", retryAfterSeconds: Math.ceil((oldest + DAY_MS - now.getTime()) / 1000) };
  }
  return { ok: true };
}
