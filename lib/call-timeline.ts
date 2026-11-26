/**
 * lib/call-timeline.ts
 *
 * Pure: turns call events into plain-language timeline rows. Transcript lines
 * are left out (they have their own card). Safe word attempt text is never
 * read, only the `matched` flag. Numbers are expected to be masked already.
 */

import type { CallEventRow, CallOutcome } from "@/lib/db";
import { callbackText, stateText } from "@/lib/live-format";
import type { CallbackStatus } from "@/lib/live-status";

function toCallbackStatus(v: unknown): CallbackStatus {
  return v === "denied" || v === "confirmed" || v === "no_answer" ? v : "pending";
}

export interface TimelineRow {
  id: string;
  at: string;
  text: string;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function describe(e: CallEventRow): string | null {
  const p = e.payload;
  switch (e.type) {
    case "red_flag": {
      const flag = str(p["flag"]);
      return flag ? `Warning sign found: ${flag.replace(/_/g, " ")}` : null;
    }
    case "safe_word_attempt":
      return p["matched"] === true ? "Safe word given: correct" : "Safe word given: wrong";
    case "callback_started":
      return callbackText("calling", str(p["target_phone"]));
    case "callback_result":
      return callbackText(toCallbackStatus(p["outcome"]), null);
    case "state_change": {
      const to = str(p["to"]);
      return to ? stateText(to as Parameters<typeof stateText>[0]) : null;
    }
    case "alert_sent": {
      const to = str(p["recipient"]);
      return `Alert sent by ${p["channel"] === "call" ? "phone call" : "text message"}${to ? ` to ${to}` : ""}`;
    }
    default:
      return null;
  }
}

export function buildTimeline(events: CallEventRow[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const e of [...events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const text = describe(e);
    if (text) rows.push({ id: e.id, at: e.created_at, text });
  }
  return rows;
}

const OUTCOME_TEXT: Record<CallOutcome, string> = {
  transferred: "Connected to the family",
  blocked: "Call not connected",
  dropped: "Caller hung up",
  time_wasted: "Caller kept busy, then the call ended",
  unknown: "Not recorded",
};

export function outcomeText(outcome: CallOutcome | null, ended: boolean): string {
  if (!outcome) return ended ? "Not recorded" : "Call in progress";
  return OUTCOME_TEXT[outcome] ?? "Not recorded";
}
