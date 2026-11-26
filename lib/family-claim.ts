/**
 * lib/family-claim.ts
 *
 * Pure, deterministic detector for "the caller says they are family".
 * Used when the AI is unavailable (so the safe word challenge still happens)
 * and by the mock AI, so both agree.
 *
 * Whole-word matching only. A caller must identify as the relative, or
 * address the senior as a relative ("Grandma, it's ..."). Talking ABOUT a
 * relative ("I'm calling about your grandson's prescription") is not a claim.
 */

const ELDER = String.raw`(?:grand(?:ma|mother|pa|father|mom|mommy|dad|daddy)|gran|granny|grammy|grampy|nana|nan|nonna|nonno|oma|opa|abuela|abuelo|mom|mum|mama|dad|papa)`;
const RELATIVE = String.raw`(?:grandson|granddaughter|grandchild|grandkid|grandchildren|son|daughter)`;
const SELF = String.raw`(?:i['’]?m|i\s+am|this\s+is|it['’]?s|it\s+is)`;

const PATTERNS: RegExp[] = [
  // "it's me", "this is me", "guess who"
  new RegExp(String.raw`\b(?:it['’]?s|it\s+is|this\s+is)\s+me\b`, "i"),
  /\bguess\s+who\b/i,
  // "Grandma it's ...", "Hi Nana, this is ..."
  new RegExp(String.raw`\b${ELDER}\b[\s,.!:;-]*${SELF}\b`, "i"),
  // "Hi Grandma" / "Hello Grandpa" greeting at the start of the line
  new RegExp(String.raw`^\s*(?:hi|hello|hey|hiya)\b[\s,!.-]*${ELDER}\b`, "i"),
  // "I'm your grandson", "this is your daughter", "it's Margaret's grandson"
  new RegExp(String.raw`\b${SELF}\s+(?:your|my\s+own|(?:[a-z]+['’]s))\s+${RELATIVE}\b(?!['’]?s\b)`, "i"),
  // "I'm a grandson", "I am the granddaughter" (not "'s": possessive)
  new RegExp(String.raw`\b(?:i['’]?m|i\s+am)\s+(?:the\s+|a\s+)?${RELATIVE}\b(?!['’]?s\b)`, "i"),
  // "your son here", "your grandson calling"
  new RegExp(String.raw`\byour\s+${RELATIVE}\s+(?:here|calling)\b`, "i"),
];

/** True when the speech claims a family relationship. Pure; no I/O. */
export function claimsFamilyByPattern(speech: string | null | undefined): boolean {
  if (typeof speech !== "string" || speech.trim() === "") return false;
  return PATTERNS.some((p) => p.test(speech));
}
