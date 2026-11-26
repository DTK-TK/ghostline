/**
 * lib/providers/assert.ts
 *
 * Startup guard. In production (VERCEL_ENV=production) it refuses mock,
 * Ollama or unknown providers and missing required settings. Outside
 * production it never throws. Messages name variables, never values.
 */

export const REQUIRED_PRODUCTION_ENV = [
  "TWILIO_AUTH_TOKEN",
  "PUBLIC_BASE_URL",
  "GEMINI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DASHBOARD_PASSCODE",
] as const;

type EnvLike = Record<string, string | undefined>;

export function assertProductionProviders(env: EnvLike = process.env): void {
  if (env.VERCEL_ENV !== "production") return;

  const problems: string[] = [];

  if ((env.MOCK_TELEPHONY ?? "").trim().toLowerCase() === "true") {
    problems.push("MOCK_TELEPHONY=true is not allowed; unset it or set it to false");
  }

  const rawAi = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const ai = rawAi === "" ? "gemini" : rawAi;
  if (ai === "mock" || ai === "ollama") {
    problems.push(`AI_PROVIDER=${ai} is not allowed; use gemini`);
  } else if (ai !== "gemini") {
    problems.push("AI_PROVIDER has an unknown value; only gemini is allowed");
  }

  for (const name of REQUIRED_PRODUCTION_ENV) {
    if (!env[name] || env[name]!.trim() === "") {
      problems.push(`${name} is missing or blank`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "Ghostline refuses to start in production:\n- " + problems.join("\n- "),
    );
  }
}
