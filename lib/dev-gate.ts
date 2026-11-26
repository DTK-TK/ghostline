/**
 * lib/dev-gate.ts
 *
 * Single gate for /dev/phone and /api/dev/*. These use the service role, so
 * they must never be reachable on production or on a Vercel preview unless
 * ENABLE_DEV_TOOLS=true is set on purpose.
 *
 * Enabled when VERCEL_ENV is not "production" AND
 * (ENABLE_DEV_TOOLS === "true" OR NODE_ENV === "development").
 */

export type DevGateEnv = Record<string, string | undefined>;

export function devToolsEnabled(env: DevGateEnv = process.env): boolean {
  if (env.VERCEL_ENV === "production") return false;
  return env.ENABLE_DEV_TOOLS === "true" || env.NODE_ENV === "development";
}

/** 404 response for dev routes when the gate is closed. */
export function devToolsNotFound(): Response {
  return new Response("Not found", { status: 404 });
}
