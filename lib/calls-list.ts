/**
 * lib/calls-list.ts
 *
 * Calls page logic. Pure helpers (cursor parsing, row mapping) plus
 * loadCallsPage(), which reads through lib/db.ts. Rows carry only masked
 * numbers; safe_word_hash and full numbers never reach the page.
 */

import { z } from "zod";
import {
  getCallsPage,
  getFraudReportIds,
  getServedHouseholdId,
  getStateChangeEventsByCall,
  type CallEventRow,
  type CallRow,
} from "@/lib/db";
import { timeWastedSummary, type TimeWastedSummary } from "@/lib/time-waster";
import { maskNumber } from "@/lib/live-public";
import type { LiveLevel } from "@/lib/live-status";

export const PAGE_SIZE = 25;

/** Cursor = the started_at of the last row already shown. */
export const CursorSchema = z.iso.datetime({ offset: true });

/** Returns a normalised ISO cursor, or null when absent/invalid. */
export function parseCursor(raw: unknown): string | null {
  const r = CursorSchema.safeParse(raw);
  if (!r.success) return null;
  const t = Date.parse(r.data);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface CallListRow {
  id: string;
  startedAt: string;
  from: string;
  claimedIdentity: string | null;
  /** null when the call was never scored. */
  level: LiveLevel | null;
  score: number | null;
  outcome: string | null;
  simulated: boolean;
  reportId: string | null;
  /** null when the call never entered time_wasted. */
  timeWasted: TimeWastedSummary | null;
}

export interface CallsPageData {
  rows: CallListRow[];
  nextCursor: string | null;
}

function levelOf(call: CallRow): LiveLevel | null {
  if (call.risk_level === "critical") return "high";
  return call.risk_level;
}

export function toCallListRow(
  call: CallRow,
  reportId: string | null,
  events: readonly CallEventRow[] = [],
  now: Date = new Date(),
): CallListRow {
  return {
    timeWasted: timeWastedSummary(events, now),
    id: call.id,
    startedAt: call.started_at,
    from: maskNumber(call.from_number),
    claimedIdentity: call.claimed_identity,
    level: levelOf(call),
    score: call.risk_score,
    outcome: call.outcome,
    simulated: call.is_simulated,
    reportId,
  };
}

/** Maps rows already fetched with limit+1 into a page and its next cursor. */
export function buildPage(
  calls: CallRow[],
  reports: Record<string, string>,
  pageSize = PAGE_SIZE,
  events: Record<string, CallEventRow[]> = {},
  now: Date = new Date(),
): CallsPageData {
  const hasMore = calls.length > pageSize;
  const shown = calls.slice(0, pageSize);
  return {
    rows: shown.map((c) => toCallListRow(c, reports[c.id] ?? null, events[c.id] ?? [], now)),
    nextCursor: hasMore && shown.length > 0 ? shown[shown.length - 1].started_at : null,
  };
}

export async function loadCallsPage(before?: string | null): Promise<CallsPageData> {
  const householdId = await getServedHouseholdId();
  if (!householdId) return { rows: [], nextCursor: null };
  const calls = await getCallsPage(householdId, PAGE_SIZE + 1, before ?? undefined);
  const ids = calls.slice(0, PAGE_SIZE).map((c) => c.id);
  const [reports, events] = await Promise.all([
    getFraudReportIds(ids),
    getStateChangeEventsByCall(ids),
  ]);
  return buildPage(calls, reports, PAGE_SIZE, events, new Date());
}
