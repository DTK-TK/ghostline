/**
 * lib/report-view.ts
 *
 * Pure helpers for the /reports/[id] page: id validation, risk display
 * (colour AND text label) and an unambiguous time string.
 */

import { parseCallId } from "@/lib/call-id";

/** Returns the report id when it is a valid uuid, else null (page 404s). */
export function parseReportId(raw: unknown): string | null {
  return parseCallId(raw);
}

export interface RiskDisplay {
  /** Text label shown next to the colour (accessibility). */
  label: "LOW" | "MEDIUM" | "HIGH";
  /** Tailwind classes. Full literal class names so Tailwind can find them. */
  className: string;
}

const PRINT = "print:border-black print:bg-transparent print:text-black";

/**
 * LOW green-500, MEDIUM amber-500, HIGH red-500. "critical" counts as HIGH.
 * Unknown values show as HIGH: a report only exists for HIGH calls.
 */
export function riskDisplay(level: string): RiskDisplay {
  switch (level.toLowerCase()) {
    case "low":
      return {
        label: "LOW",
        className: `border-green-500 bg-green-500/15 text-green-500 ${PRINT}`,
      };
    case "medium":
      return {
        label: "MEDIUM",
        className: `border-amber-500 bg-amber-500/15 text-amber-500 ${PRINT}`,
      };
    default:
      return {
        label: "HIGH",
        className: `border-red-500 bg-red-500/15 text-red-500 ${PRINT}`,
      };
  }
}

/** ISO UTC time (ASCII, same on server and client). Bad input is returned as-is. */
export function formatReportTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace(".000Z", "Z");
}
