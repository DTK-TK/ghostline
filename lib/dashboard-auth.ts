/**
 * Dashboard passcode helpers (pure, no I/O).
 *
 * The cookie never holds the passcode. It holds HMAC-SHA256(key = passcode,
 * message = a fixed label), so it can be checked by recomputing it, and the
 * passcode cannot be read back from it. Changing DASHBOARD_PASSCODE
 * invalidates every existing cookie.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const DASHBOARD_COOKIE = "ghostline_dash";
export const DASHBOARD_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
export const UNLOCK_PATH = "/unlock";
const TOKEN_LABEL = "ghostline-dashboard-session-v1";

/** The configured passcode, or null when unset or blank (fail closed). */
export function configuredPasscode(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env.DASHBOARD_PASSCODE;
  return value && value.trim().length > 0 ? value : null;
}

/** Value stored in the cookie for a given passcode. */
export function deriveToken(passcode: string): string {
  return createHmac("sha256", passcode).update(TOKEN_LABEL).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  // Hash both sides first so the buffers have equal length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True when the submitted passcode matches. False if none is configured. */
export function verifyPasscode(
  submitted: unknown,
  passcode: string | null = configuredPasscode(),
): boolean {
  if (!passcode || typeof submitted !== "string") return false;
  return constantTimeEqual(submitted, passcode);
}

/** True when the cookie value is the token derived from the configured passcode. */
export function isValidToken(
  cookieValue: string | undefined | null,
  passcode: string | null = configuredPasscode(),
): boolean {
  if (!passcode || !cookieValue) return false;
  return constantTimeEqual(cookieValue, deriveToken(passcode));
}

/**
 * Accept only a same-site relative path. Anything else becomes "/live".
 * Rejects absolute URLs, protocol-relative "//host", backslash tricks and
 * control characters.
 */
export function safeNextPath(next: unknown, fallback = "/live"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  // Never bounce back to the unlock page or its submit route.
  if (next === UNLOCK_PATH || next.startsWith(UNLOCK_PATH + "?") || next.startsWith("/api/unlock")) {
    return fallback;
  }
  return next;
}
