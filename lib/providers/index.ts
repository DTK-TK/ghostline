/**
 * lib/providers/index.ts
 *
 * Provider selection and factory. Reads env vars and instantiates the
 * correct telephony and AI implementations.
 *
 * Safety:
 *   - If VERCEL_ENV === "production" and any mock is selected, throws at startup.
 *   - All app code must import from this file, never directly from twilio or
 *     @google/genai.
 */

import type { TelephonyProvider } from "./telephony";
import { TwilioTelephony, MockTelephony } from "./telephony";
import type { AIProvider } from "./ai";
import { GeminiAI, OllamaAI, MockAI } from "./ai";

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

let _telephony: TelephonyProvider | null = null;
let _ai: AIProvider | null = null;

function createTelephonyProvider(): TelephonyProvider {
  const useMock = process.env.MOCK_TELEPHONY === "true";

  // Safety check: no mock in production
  if (process.env.VERCEL_ENV === "production" && useMock) {
    throw new Error(
      "MOCK_TELEPHONY=true is not allowed in production (VERCEL_ENV=production). " +
      "Set MOCK_TELEPHONY=false or unset it.",
    );
  }

  if (useMock) {
    console.log("[Providers] Using MockTelephony (dev/test mode)");
    return new MockTelephony();
  }

  console.log("[Providers] Using TwilioTelephony (production mode)");
  return new TwilioTelephony();
}

function createAIProvider(): AIProvider {
  const provider = (process.env.AI_PROVIDER ?? "gemini").toLowerCase();

  // Safety check: no mock in production
  if (process.env.VERCEL_ENV === "production" && provider === "mock") {
    throw new Error(
      "AI_PROVIDER=mock is not allowed in production (VERCEL_ENV=production). " +
      "Use AI_PROVIDER=gemini or AI_PROVIDER=ollama.",
    );
  }

  switch (provider) {
    case "mock":
      console.log("[Providers] Using MockAI (dev/test mode)");
      return new MockAI();

    case "ollama":
      console.log("[Providers] Using OllamaAI (local dev mode)");
      return new OllamaAI();

    case "gemini":
      console.log("[Providers] Using GeminiAI (production mode)");
      return new GeminiAI();

    default:
      throw new Error(
        `Unknown AI_PROVIDER: "${provider}". Valid options: gemini, ollama, mock.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Singleton accessors (lazy init)
// ---------------------------------------------------------------------------

export function getTelephony(): TelephonyProvider {
  if (!_telephony) _telephony = createTelephonyProvider();
  return _telephony;
}

export function getAI(): AIProvider {
  if (!_ai) _ai = createAIProvider();
  return _ai;
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { TelephonyProvider } from "./telephony";
export type { AIProvider, ConversationTurn, PersonaContext, AITurnResponse } from "./ai";
export { AIUnavailableError } from "./ai";
