/**
 * Client-safe (no server imports). "2026-12-04T15:30:00.000Z" becomes
 * "Dec 4, 2026, 3:30 PM EST" in the viewer's time zone.
 */
export function formatStart(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}
