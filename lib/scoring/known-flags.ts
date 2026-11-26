/**
 * Flag ids allowed to become scoring input or stored red_flag evidence.
 * Matches the flag table in scam-rules.md.
 */
export const KNOWN_FLAG_IDS = [
  "payment_method",
  "secrecy",
  "authority",
  "emergency_story",
  "urgency",
  "remote_access",
  "safe_word_fail",
  "callback_denied",
] as const;

const KNOWN = new Set<string>(KNOWN_FLAG_IDS);

/** Drop any flag id that is not in KNOWN_FLAG_IDS (e.g. AI-invented ones). */
export function filterKnownFlags(flags: readonly string[]): string[] {
  return flags.filter((f) => KNOWN.has(f));
}
