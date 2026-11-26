import bcrypt from "bcryptjs";

/** Standard bcrypt hash: $2a$, $2b$ or $2y$, two-digit cost, 53 chars of salt+hash. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** Spoken lead-ins removed before the second comparison. Matched on lowercase text. */
const LEAD_INS = /^\s*(?:the\s+family\s+word\s+is|the\s+word\s+is|it['’]?s|it\s+is)\b[\s,:-]*/;

function singulariseWord(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Lowercase, trim, strip punctuation (keep letters, digits, inner spaces),
 * collapse spaces and singularise each word. Used for the stored word at
 * setup and for every attempt.
 */
export function normalise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .map(singulariseWord)
    .join(" ");
}

/** Removes one spoken lead-in ("it's", "the word is", ...) from raw speech. */
export function stripLeadIn(input: string): string {
  return input.toLowerCase().replace(LEAD_INS, "").trim();
}

/**
 * Compares a spoken attempt with the stored bcrypt hash. At most 2 bcrypt
 * compares: the normalised attempt, then the normalised lead-in-stripped
 * attempt (skipped when identical or empty). Never logs the hash or attempt.
 */
export async function checkSafeWord(
  attempt: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (typeof hash !== "string" || !BCRYPT_HASH.test(hash)) {
    console.error("[safe-word] stored safe word hash is missing or invalid");
    return false;
  }

  const candidates: string[] = [];
  for (const c of [normalise(attempt ?? ""), normalise(stripLeadIn(attempt ?? ""))]) {
    if (c && !candidates.includes(c)) candidates.push(c);
  }

  for (const candidate of candidates.slice(0, 2)) {
    try {
      if (await bcrypt.compare(candidate, hash)) return true;
    } catch {
      console.error("[safe-word] bcrypt comparison failed");
      return false;
    }
  }
  return false;
}
