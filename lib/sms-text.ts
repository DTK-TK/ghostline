/**
 * lib/sms-text.ts
 *
 * Pure helpers that make caller-derived text safe for the family SMS:
 * ASCII only, no control characters, no URLs or domain-like tokens, capped.
 */

const URL_RE = /(?:https?:\/\/|www\.)\S*/gi;
const DOMAIN_RE = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\S*/gi;

/** Remove URLs and domain-like tokens, normalise whitespace. ASCII output. */
export function cleanSmsText(input: string | null | undefined): string {
  if (!input) return "";
  let s = input
    .normalize("NFKD")
    // Control characters and everything outside printable ASCII become a space.
    .replace(/[^\x20-\x7e]/g, " ");
  s = s.replace(URL_RE, " ").replace(DOMAIN_RE, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Cut to at most `max` characters, ending in "..." when something was cut. */
export function capSmsText(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 3).trimEnd() + "...";
}

/** Clean, cap, then clean again so a cut cannot leave a new domain-like token. */
export function fieldForSms(
  input: string | null | undefined,
  max: number,
  fallback: string,
): string {
  const cleaned = cleanSmsText(input);
  if (!cleaned) return capSmsText(fallback, max);
  const capped = capSmsText(cleaned, max);
  return cleanSmsText(capped) || capSmsText(fallback, max);
}

export interface SmsFields {
  who: string;
  amount: string;
  payment: string;
}

export const SMS_MAX = 320;
const CAPS = { who: 40, amount: 20, payment: 20 } as const;

/**
 * Assemble the risk SMS. `render` builds the text before the link from the
 * fields. Fields are shrunk (longest first) until prefix + text + link fits in
 * SMS_MAX. The link is appended last and never cut.
 */
export function fitFields(
  raw: { who: string | null | undefined; amount: string | null | undefined; payment: string | null | undefined },
  render: (f: SmsFields) => string,
  reserved: number,
): string {
  const limits: Record<keyof SmsFields, number> = { ...CAPS };
  const make = (): SmsFields => ({
    who: fieldForSms(raw.who, limits.who, "unknown"),
    amount: fieldForSms(raw.amount, limits.amount, "none"),
    payment: fieldForSms(raw.payment, limits.payment, "none"),
  });
  let fields = make();
  let text = render(fields);
  while (text.length + reserved > SMS_MAX) {
    const key = (Object.keys(limits) as (keyof SmsFields)[]).reduce((a, b) =>
      fields[b].length > fields[a].length ? b : a,
    );
    if (fields[key].length === 0) break;
    limits[key] = fields[key].length - 1;
    fields = make();
    text = render(fields);
  }
  return text;
}
