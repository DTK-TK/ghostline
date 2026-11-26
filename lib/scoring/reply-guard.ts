/**
 * Reply guard: enforces the voice rules on AI replies in code.
 * Returns the trimmed text when it passes, or null when the engine should use
 * the scripted band line instead.
 */

const MAX_SENTENCES = 2;
const MAX_WORDS_EXCLUSIVE = 25; // 25 or more words is rejected

const ACCUSATORY = /\b(scam|scams|scammer|scammers|fraud|frauds|fraudster|fraudsters|criminal|criminals)\b/i;
const OPENING_LINES = [/this call is screened by ghostline/i, /you['\u2019]ve reached the/i];

export interface ReplyGuardOptions {
  /** Replies with this many words or more are rejected. Default 25. */
  maxWords?: number;
}

export function validateReply(text: string, options: ReplyGuardOptions = {}): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const words = trimmed.split(/\s+/).length;
  if (words >= (options.maxWords ?? MAX_WORDS_EXCLUSIVE)) return null;

  const sentences = trimmed.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim().length > 0);
  if (sentences.length > MAX_SENTENCES) return null;

  if (ACCUSATORY.test(trimmed)) return null;
  if (OPENING_LINES.some((re) => re.test(trimmed))) return null;

  return trimmed;
}
