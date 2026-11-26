/**
 * lib/scoring/rules.ts
 *
 * Deterministic, synchronous, zero-network scam rules scorer.
 *
 * Weights and flag IDs are taken verbatim from scam-rules.md.
 * scoreRules() is a pure function: same input always produces same output.
 * It can be called at any point without async or DB access.
 *
 * Usage:
 *   const { score, flags } = scoreRules(transcript);
 */

// ---------------------------------------------------------------------------
// Rule table — mirrored from scam-rules.md
// ---------------------------------------------------------------------------

export interface RuleFlag {
  id: string;
  points: number;
  /** Keyword/phrase patterns that trigger this flag. */
  patterns: RegExp[];
}

/** All scam signal rules, ordered by weight descending. */
export const RULES: RuleFlag[] = [
  {
    id: "payment_method",
    points: 40,
    patterns: [
      /gift\s*card/i,
      /itunes/i,
      /google\s*play/i,
      /bitcoin/i,
      /crypto/i,
      /wire\s*transfer/i,
      /western\s*union/i,
      /money\s*gram/i,
      /courier\s*(will\s*)?(pick|collect)/i,
      /someone\s+will\s+pick\s+it\s+up/i,
      /e[-\s]?transfer/i,
    ],
  },
  {
    id: "secrecy",
    points: 30,
    patterns: [
      /don'?t\s+tell/i,
      /keep\s+this\s+(between|secret)/i,
      /don'?t\s+(call|contact)\s+anyone/i,
      /don'?t\s+mention/i,
      /nobody\s+(else\s+)?needs?\s+to\s+know/i,
      /just\s+between\s+us/i,
    ],
  },
  {
    id: "authority",
    points: 30,
    patterns: [
      /\bC\.?R\.?A\.?\b/i,
      /canada\s+revenue/i,
      /revenue\s+agency/i,
      /\bI\.?R\.?S\.?\b/i,
      /\brcmp\b/i,
      /\bpolice\b/i,
      /\bfbi\b/i,
      /\bcourt\b/i,
      /\bjudge\b/i,
      /arrest\s*warrant/i,
      /microsoft\s*(support|tech)/i,
      /\bbank\s+fraud\s+department/i,
      /visa\s+security/i,
      /mastercard\s+security/i,
      /\blawyer\b/i,
      /law\s+enforcement/i,
    ],
  },
  {
    id: "emergency_story",
    points: 25,
    patterns: [
      /\bjail\b/i,
      /\barrested\b/i,
      /\bbail\b/i,
      /\baccident\b/i,
      /\bhospital\b/i,
      /\bkidnap/i,
      /\bheld\s+hostage/i,
      /\bemergency\b/i,
      /\burgent\s+matter/i,
      /in\s+trouble/i,
      /\binjured\b/i,
    ],
  },
  {
    id: "urgency",
    points: 20,
    patterns: [
      /right\s+now/i,
      /\btonight\b/i,
      /immediately/i,
      /before\s+it'?s?\s+too\s+late/i,
      /within\s+(the\s+)?(hour|minutes?|today)/i,
      /deadline/i,
      /time\s+(is\s+)?running\s+out/i,
      /\basap\b/i,
      /don'?t\s+delay/i,
      /\bnow\s+or\s+never\b/i,
    ],
  },
  {
    id: "remote_access",
    points: 30,
    patterns: [
      /\banydesk\b/i,
      /\bteamviewer\b/i,
      /\bremote\s+(access|desktop|control)\b/i,
      /download\s+(this|the|our)\s+(app|software|program)/i,
      /give\s+(me|us)\s+(the\s+)?code/i,
      /\binstall\b.*\b(this|our|the)\b/i,
      /grant\s+(me|us)\s+access/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RulesResult {
  /** Raw score from rules layer (0–∞ before cap). Call combine.ts to cap. */
  score: number;
  /** IDs of triggered flags, deduplicated. */
  flags: string[];
}

/**
 * Score an array of transcript strings against the deterministic rules table.
 *
 * @param transcript - Array of caller utterances collected so far.
 *   Caller turns only; system/persona lines must NOT be included.
 * @returns { score, flags } — score is the sum of unique flag weights.
 *   Each flag fires at most once per call regardless of repetition.
 */
export function scoreRules(transcript: string[]): RulesResult {
  const combined = transcript.join(" ");
  const triggered = new Set<string>();

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(combined)) {
        triggered.add(rule.id);
        break; // one hit is enough to fire the flag
      }
    }
  }

  const flags = Array.from(triggered);
  const score = flags.reduce((sum, id) => {
    const rule = RULES.find((r) => r.id === id);
    return sum + (rule?.points ?? 0);
  }, 0);

  return { score, flags };
}
