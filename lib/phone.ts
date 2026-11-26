/**
 * Shared phone-number masking. Lives here (not in lib/callback.ts) so that
 * lib/providers can use it without an import cycle.
 */

/** "+15551234567" -> "***4567". Used for every log line and stored value. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}
