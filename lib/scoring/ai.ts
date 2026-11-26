/**
 * lib/scoring/ai.ts
 *
 * Thin adapter between lib/conversation.ts and the AI provider layer.
 *
 * Previously contained a direct Gemini call; now delegates to getAI() from
 * lib/providers so the app can run with Gemini, Ollama, or MockAI without
 * changing any call sites.
 *
 * The types (GeminiResponse, ConversationTurn, GeminiUnavailableError) and
 * the callGemini() signature are preserved so lib/conversation.ts requires
 * no changes.
 */

import { getAI, AIUnavailableError } from "@/lib/providers";
import type { AITurnResponse, ConversationTurn, PersonaContext } from "@/lib/providers";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Re-export schema under the legacy name so callers still validate the same way
// ---------------------------------------------------------------------------

export const GeminiResponseSchema = z.object({
  reply:             z.string().min(1),
  risk_score:        z.number().int().min(0).max(100),
  flags:             z.array(z.string()),
  claimed_identity:  z.string().nullable(),
  claims_family:     z.boolean(),
  requested_amount:  z.string().nullable(),
  payment_method:    z.string().nullable(),
  summary:           z.string(),
});

export type GeminiResponse = AITurnResponse;

// ---------------------------------------------------------------------------
// Re-export types so lib/conversation.ts import sites still resolve
// ---------------------------------------------------------------------------

export type { ConversationTurn };

// ---------------------------------------------------------------------------
// Error type (re-exported from provider layer under the legacy name)
// ---------------------------------------------------------------------------

export { AIUnavailableError as GeminiUnavailableError };

// ---------------------------------------------------------------------------
// callGemini — now delegates to the active AI provider
// ---------------------------------------------------------------------------

/**
 * Call the active AI provider with the conversation history.
 *
 * The function signature is preserved from the original Gemini-only
 * implementation so lib/conversation.ts requires no changes.
 *
 * @throws GeminiUnavailableError (= AIUnavailableError) on failure.
 */
export async function callGemini(
  familyName: string,
  history: ConversationTurn[],
  latestSpeech: string,
  inTimeWaster = false,
): Promise<GeminiResponse> {
  const context: PersonaContext = { familyName, inTimeWaster };
  // getAI() / new GeminiAI() throw a plain Error when GEMINI_API_KEY is
  // missing. Convert that into AIUnavailableError so engine() falls back to
  // rules-only scoring instead of dropping the call.
  let provider: ReturnType<typeof getAI>;
  try {
    provider = getAI();
  } catch (err) {
    throw err instanceof AIUnavailableError ? err : new AIUnavailableError(err);
  }
  return provider.generateTurn(history, latestSpeech, context);
}
