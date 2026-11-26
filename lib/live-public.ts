/**
 * lib/live-public.ts
 *
 * Pure projection of DB rows to what the polling route may return.
 * Never includes: safe_word_hash (households are not read here), safe word
 * attempt text, or full phone numbers (masked to the last four digits).
 */

import type { CallEventRow, CallRow } from "@/lib/db";

export type PublicCall = CallRow;
export type PublicEvent = CallEventRow;

export function maskNumber(phone: unknown): string {
  const digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  return digits.length >= 4 ? `\u2022\u2022\u2022\u2022 ${digits.slice(-4)}` : "\u2022\u2022\u2022\u2022";
}

export function toPublicCall(call: CallRow): PublicCall {
  return { ...call, from_number: maskNumber(call.from_number) };
}

export function toPublicEvent(event: CallEventRow): PublicEvent {
  const p = event.payload;
  switch (event.type) {
    case "safe_word_attempt":
      // Only the outcome is public. The attempt text is dropped.
      return { ...event, payload: { matched: p["matched"] === true } };
    case "callback_started":
      return { ...event, payload: { ...p, target_phone: maskNumber(p["target_phone"]) } };
    case "alert_sent":
      return { ...event, payload: { ...p, recipient: maskNumber(p["recipient"]) } };
    default:
      return event;
  }
}
