/**
 * lib/risk-display.ts
 *
 * Pure mapping from risk level to label and Tailwind colour classes.
 * Colour is never the only signal: the label is always shown with it.
 */

import type { LiveLevel } from "@/lib/live-status";

export const RISK_MARKS = [40, 70] as const;

export interface RiskDisplay {
  label: "LOW" | "MEDIUM" | "HIGH";
  bar: string;
  text: string;
}

const DISPLAY: Record<LiveLevel, RiskDisplay> = {
  low: { label: "LOW", bar: "bg-green-500", text: "text-green-500" },
  medium: { label: "MEDIUM", bar: "bg-amber-500", text: "text-amber-500" },
  high: { label: "HIGH", bar: "bg-red-500", text: "text-red-500" },
};

export function riskDisplay(level: LiveLevel): RiskDisplay {
  return DISPLAY[level];
}

/** Score clamped to 0..100 and rounded, safe for a bar width. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score)));
}
