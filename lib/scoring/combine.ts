/**
 * lib/scoring/combine.ts
 *
 * Merges the rules layer score and the AI score into a final risk assessment,
 * then applies the safe-word and callback adjustments from scam-rules.md.
 *
 * Rules (verbatim from scam-rules.md):
 *   final score = max(rules_score, ai_score)
 *   correct safe word → subtract 40, floor 0 (never cancels callback_denied)
 *   callback_denied   → add 100 (uncapped, never reduced by safe word)
 *
 * Risk bands:
 *   LOW     0 – 39
 *   MEDIUM  40 – 69
 *   HIGH    70+
 *
 * Note: scam-rules.md uses LOW/MEDIUM/HIGH. The DB schema has an extra
 * "critical" level for future use; combine.ts never produces "critical"
 * directly — that is reserved for explicit overrides (e.g. a confirmed
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
}

export interface CombineResult {
  score: number;
  level: RiskLevel;
  flags: string[];
}

// ---------------------------------------------------------------------------
// Band mapping
// ---------------------------------------------------------------------------

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

  // 1. Take the higher of the two layers.
  let score = Math.max(rulesScore, aiScore);

  // 2. callback_denied is a hard escalation — applied before safe-word credit
  //    so safe_word can never cancel a confirmed denial.
  if (callbackDenied) {
    score += 100;
  }

  // 3. Correct safe word subtracts 40, floor 0, but NOT if callback_denied.
  if (safeWordCorrect && !callbackDenied) {
    score = Math.max(0, score - 40);
  }

  // 4. Monotonic floor — score only ever rises across a call's lifetime.
  score = Math.max(score, priorScore);

  // 5. Hard cap at 100 for storage (the DB column is 0–100).
  score = Math.min(100, score);

  const level = scoreToLevel(score);
  const flags = Array.from(new Set(allFlags));

  return { score, flags, level };
}
