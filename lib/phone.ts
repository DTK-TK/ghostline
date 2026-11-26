/**
 * Shared phone-number masking. Lives here (not in lib/callback.ts) so that
 * lib/providers can use it without an import cycle.
 */

/** "+15551234567" -> "***4567". Used for every log line and stored value. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

/** Replace every phone-number-looking run of digits in free text with its masked form. */
export function maskPhonesInText(text: string): string {
  // E.164 or a bare 10-15 digit run. Digit runs inside ids and URLs (next to
  // letters or hyphens) are left alone so links stay intact.
  return text.replace(/(?<![\w-])\+?\d{10,15}(?![\w-])/g, (m) => maskPhone(m));
}
