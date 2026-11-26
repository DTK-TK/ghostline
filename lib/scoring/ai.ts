/**
 * lib/scoring/ai.ts
 *
 * Single Gemini call that returns structured scoring + a next persona reply.
 *
 * Model: gemini-2.5-flash
 * Mode:  responseMimeType = "application/json"
 * Timeout: 6 s via AbortSignal.timeout()
 *
 * On timeout or any error (network, invalid JSON, Zod failure) the function
 * throws GeminiUnavailableError so the caller can fall back to rules-only.
 */

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Gemini response schema (validated with Zod)
// ---------------------------------------------------------------------------

export const GeminiResponseSchema = z.object({
  /** Persona reply to speak next — must follow voice-persona.md rules. */
  reply: z.string().min(1),
  /** AI risk score 0–100. The combine layer takes max(rules, ai). */
  risk_score: z.number().int().min(0).max(100),
  /** Flag IDs the AI identified (must use the IDs from scam-rules.md). */
  flags: z.array(z.string()),
  /** What the caller said their name / organisation is, or null. */
  claimed_identity: z.string().nullable(),
  /** True if the caller claims to be a family member of the household. */
  claims_family: z.boolean(),
  /** Dollar or other amount mentioned, verbatim, or null. */
  requested_amount: z.string().nullable(),
  /** Payment method mentioned (e.g. "gift card", "wire transfer"), or null. */
  payment_method: z.string().nullable(),
  /** One-sentence running summary of the call so far. */
  summary: z.string(),
});

export type GeminiResponse = z.infer<typeof GeminiResponseSchema>;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class GeminiUnavailableError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Gemini unavailable: ${msg}`);
    this.name = "GeminiUnavailableError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(familyName: string): string {
  return `\
You are Ghostline, the AI screening assistant for the ${familyName} family's telephone line.
You are speaking to an unknown caller BEFORE connecting them to the senior resident.

PERSONA RULES (follow strictly):
- Opening line (first turn only): "You've reached the ${familyName} residence. This call is screened by Ghostline. Please say your name and why you're calling."
- Patient, warm, short sentences — maximum 2 sentences per turn, under 25 words total.
- Never sarcastic. Never accuse anyone of being a scammer.
- If you cannot connect the call: say "I'm not able to connect this call."
- Never reveal, hint at, or repeat the safe word. Never confirm whether a safe-word attempt was close.
- Never give out personal information about the household.
- TIME-WASTER MODE (only when risk is HIGH): become a slow, chatty grandmother who mishears, looks for her glasses, talks about her cat. Maximum 3 minutes, then end politely.

SCAM FLAG IDs (use exactly these strings in the "flags" array):
  payment_method, secrecy, authority, emergency_story, urgency, remote_access

NEXT-STATE GUIDANCE embedded in reply:
- If claims_family is true → ask for verification (do NOT reveal the safe word exists).
- If risk_score >= 70 → move toward blocking: reply should end the conversation politely.
- If risk_score 40-69 → take a message rather than connect.
- If risk_score < 40 and no family claim → stay neutral, ask clarifying questions.

Respond ONLY with valid JSON matching this exact schema — no markdown, no code fences:
{
  "reply": "<what Ghostline says next, following persona rules>",
  "risk_score": <integer 0-100>,
  "flags": ["<flag_id>", ...],
  "claimed_identity": "<name or org, or null>",
  "claims_family": <true|false>,
  "requested_amount": "<amount string or null>",
  "payment_method": "<payment type string or null>",
  "summary": "<one sentence summary of the call so far>"
}`;
}

// ---------------------------------------------------------------------------
// History formatter
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  speaker: "caller" | "system";
  text: string;
}

function formatHistory(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "(No conversation yet.)";
  return turns
    .map((t) => `${t.speaker === "caller" ? "CALLER" : "GHOSTLINE"}: ${t.text}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Call Gemini with the full conversation history and get a structured response.
 *
 * @param familyName  - Used in the system prompt.
 * @param history     - All turns so far, oldest first.
 * @param latestSpeech - The caller's most recent utterance (appended to history).
 * @throws GeminiUnavailableError on timeout, network error, or invalid JSON.
 */
export async function callGemini(
  familyName: string,
  history: ConversationTurn[],
  latestSpeech: string,
): Promise<GeminiResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiUnavailableError("Missing GEMINI_API_KEY");

  const allTurns: ConversationTurn[] = [
    ...history,
    { speaker: "caller", text: latestSpeech },
  ];

  const userMessage = `Conversation history:\n${formatHistory(allTurns)}\n\nLatest caller utterance: "${latestSpeech}"\n\nRespond with JSON only.`;

  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: userMessage,
      config: {
        systemInstruction: buildSystemPrompt(familyName),
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: 512,
        abortSignal: AbortSignal.timeout(6000),
      },
    });

    const raw = response.text;
    if (!raw) throw new Error("Empty response from Gemini");

    const parsed: unknown = JSON.parse(raw);
    return GeminiResponseSchema.parse(parsed);
  } catch (err) {
    throw new GeminiUnavailableError(err);
  }
}
