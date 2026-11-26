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
// Rule table - mirrored from scam-rules.md
// ---------------------------------------------------------------------------

export interface RuleFlag {
  id: string;
  points: number;
  /** Keyword/phrase patterns that trigger this flag. */
  patterns: RegExp[];
  /**
   * Patterns that must match inside a SINGLE caller turn (money context for
   * words like "wire" or "courier" that are harmless on their own).
   */
  sameTurnPatterns?: RegExp[];
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
      /someone\s+will\s+pick\s+it\s+up/i,
      /e[-\s]?transfer/i,
    ],
    sameTurnPatterns: [
      // bare "wire" / "courier" only count with money context in the same turn
      /\bwire[ds]?\b.{0,40}\b(money|funds?|cash|transfer|send)\b|\b(money|funds?|cash|transfer|send)\b.{0,40}\bwire[ds]?\b|\bwire[ds]?\b.{0,40}\$|\$.{0,40}\bwire[ds]?\b/i,
      // courier (incl. "courier will pick up / collect") needs money context within 40 chars
      /\bcourier\b.{0,40}(\b(cash|money|funds?|payment|gift\s*card)\b|\$)|(\b(cash|money|funds?|payment|gift\s*card)\b|\$).{0,40}\bcourier\b/i,
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
      /\bbank\b/i,
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
      /\binstall\b/i,
      /grant\s+(me|us)\s+access/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Longest quote stored per matched flag. */
export const QUOTE_MAX_CHARS = 120;

export interface RuleMatch {
  /** Flag id that fired. */
  flag: string;
  /** The caller utterance that contains the match, cut to QUOTE_MAX_CHARS. */
  quote: string;
}

export interface RulesResult {
  /** Raw score from rules layer (0 to infinity before cap). Call combine.ts to cap. */
  score: number;
  /** IDs of triggered flags, deduplicated. */
  flags: string[];
  /** One entry per triggered flag, in the same order as `flags`. */
  matches: RuleMatch[];
}

function cutQuote(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > QUOTE_MAX_CHARS ? t.slice(0, QUOTE_MAX_CHARS) : t;
}

/**
 * Find the caller utterance that caused a rule to fire. Prefers the first
 * single turn that matches; falls back to the matched text in the joined
 * transcript when a pattern only matches across two turns.
 */
function findQuote(rule: RuleFlag, transcript: string[], combined: string): string | null {
  const all = [...rule.patterns, ...(rule.sameTurnPatterns ?? [])];
  for (const turn of transcript) {
    if (all.some((p) => p.test(turn))) return cutQuote(turn);
  }
  for (const p of rule.patterns) {
    const m = p.exec(combined);
    if (m) return cutQuote(m[0]);
  }
  return null;
}

/**
 * Score an array of transcript strings against the deterministic rules table.
 *
 * @param transcript - Array of caller utterances collected so far.
 *   Caller turns only; system/persona lines must NOT be included.
 * @returns { score, flags, matches } - score is the sum of unique flag weights.
 *   Each flag fires at most once per call regardless of repetition.
 */
export function scoreRules(transcript: string[]): RulesResult {
  const combined = transcript.join(" ");
  const triggered = new Set<string>();
  const matches: RuleMatch[] = [];

  for (const rule of RULES) {
    const hit =
      rule.patterns.some((p) => p.test(combined)) ||
      (rule.sameTurnPatterns ?? []).some((p) => transcript.some((turn) => p.test(turn)));
    if (hit) {
      triggered.add(rule.id); // one hit is enough to fire the flag
      matches.push({ flag: rule.id, quote: findQuote(rule, transcript, combined) ?? "" });
    }
  }

  const flags = Array.from(triggered);
  const score = flags.reduce((sum, id) => {
    const rule = RULES.find((r) => r.id === id);
    return sum + (rule?.points ?? 0);
  }, 0);

  return { score, flags, matches };
}