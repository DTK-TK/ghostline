/**
 * lib/extract-evidence.ts
 *
 * Rules-based extraction of the requested amount and payment method from
 * caller speech. Used by MockAI and by the engine when the AI is down.
 */

export function extractAmount(text: string): string | null {
  // Grouped (3,000) or plain (3000) digits, so "3000" is not cut to "300".
  const pattern = /\$?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$?\d+(?:\.\d{2})?|\d+\s*(?:dollars?|bucks?)/i;
  const match = pattern.exec(text);
  return match?.[0] ?? null;
}

export function extractPaymentMethod(text: string): string | null {
  const methods = [
    "gift card",
    "iTunes",
    "Google Play",
    "bitcoin",
    "crypto",
    "wire transfer",
    "Western Union",
    "courier",
  ];
  const lower = text.toLowerCase();
  for (const method of methods) {
    if (lower.includes(method.toLowerCase())) return method;
  }
  return null;
}

/** Trimmed value, or null when empty or not a string. */
export function nonEmpty(value: string | null | undefined): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return v === "" ? null : v;
}
