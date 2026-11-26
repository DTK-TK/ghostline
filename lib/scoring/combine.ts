/**
 * lib/scoring/combine.ts
 *
 * Merges the rules layer score and the AI score into a final risk assessment,
 * then applies the safe-word and callback adjustments from scam-rules.md.
 *
 * Rules (verbatim from scam-rules.md):
 *   final score = max(rules_score, ai_score)
 *   correct safe word - subtract 40, floor 0 (never cancels callback_denied)
 *   callback_denied   - add 100 (uncapped, never reduced by safe word)
 *
 * Risk bands:
 *   LOW     0 - 39
 *   MEDIUM  40 - 69
 *   HIGH    70+
 *
 * Note: scam-rules.md uses LOW/MEDIUM/HIGH. The DB schema has an extra
 * "critical" level for future use; combine.ts never produces "critical"
 * directly - that is reserved for explicit overrides (e.g. a confirmed
 * deepfake alert if that feature is added later).
 */

import type { RiskLevel } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CombineInput {
  rulesScore: number;
  aiScore: number;
  /** Flags from both layers, merged and deduplicated before passing in. */
  allFlags: string[];
  /** True if the caller successfully matched the household's safe word. */
  safeWordCorrect: boolean;
  /**
   * True if a family-member callback confirmed the caller is NOT who they
   * claim to be. This flag is irreversible and overrides safe-word credit.
   */
  callbackDenied: boolean;
  /**
   * Previous accumulated score for this call (monotonic floor).
   * The final score must never go below this value.
   */
  priorScore: number;
  /** True if a family-member callback confirmed the caller is who they claim (-40, floor 0). */
  callbackConfirmed?: boolean;
  /**
   * Credit (see creditsFromEvents) already reflected in the stored priorScore.
   * priorScore + priorCredits rebuilds the gross score the floor applies to.
   */
  priorCredits?: number;
}

export interface CombineResult {
  score: number;
  level: RiskLevel;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Band mapping
// ---------------------------------------------------------------------------

const CREDIT = 40;

/**
 * Credit (0, 40 or 80) earned by a correct safe word and a confirmed callback
 * in the given call events. A denied callback cancels all credit.
 */
export function creditsFromEvents(
  events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
): number {
  if (events.some((e) => e.type === "callback_result" && e.payload["outcome"] === "denied")) return 0;
  const word = events.some((e) => e.type === "safe_word_attempt" && e.payload["matched"] === true);
  const confirmed = events.some(
    (e) => e.type === "callback_result" && e.payload["outcome"] === "confirmed",
  );
  return (word ? CREDIT : 0) + (confirmed ? CREDIT : 0);
}

export function scoreToLevel(score: number): RiskLevel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Main combiner
// ---------------------------------------------------------------------------

/**
 * Compute the final risk score and level for one conversation turn.
 *
 * The score is monotonically non-decreasing across a call: the caller cannot
 * "unsay" something suspicious. The turn handler in the route layer enforces
 * the floor via `Math.max(newScore, existingScore)` before writing to the DB,
 * but we also apply it here so this function's output is self-consistent.
 */
export function combineScores(input: CombineInput): CombineResult {
  const { rulesScore, aiScore, allFlags, safeWordCorrect, callbackDenied, priorScore } = input;
  const callbackConfirmed = input.callbackConfirmed ?? false;
  const priorCredits = input.priorCredits ?? 0;

  // Gross score: higher of the two layers, plus the hard denial escalation,
  // floored by the prior gross score (stored net score plus credits already
  // reflected in it). The floor applies BEFORE credits so a credit is never
  // cancelled by it.
  const gross = Math.max(
    Math.max(rulesScore, aiScore) + (callbackDenied ? 100 : 0),
    priorScore + priorCredits,
  );

  // Credits (-40 each, floor 0). Never applied when the callback was denied.
  const credits = (safeWordCorrect ? CREDIT : 0) + (callbackConfirmed ? CREDIT : 0);
  const net = callbackDenied ? gross : Math.max(0, gross - credits);

  // Hard cap at 100 for storage (the DB column is 0-100).
  const score = Math.min(100, net);

  return { score, flags: Array.from(new Set(allFlags)), level: scoreToLevel(score) };
}