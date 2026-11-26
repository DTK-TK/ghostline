/**
 * Vitest helper that mocks `@google/genai` (`GoogleGenAI.models.generateContent`)
 * so tests never need a real key or network access.
 * Not picked up by vitest (the include pattern only matches *.test.ts).
 *
 * Usage:
 *   const gemini = installGeminiMock();      // in beforeEach
 *   gemini.respondWith(validTurn());         // or respondWithText / failWith / respondSlowly
 *   const { GeminiAI } = await import("@/lib/providers/ai");
 *   ...
 *   gemini.restore();                        // in afterEach
 *
 * installGeminiMock() calls vi.resetModules() so the provider singleton in
 * lib/providers (getAI()) is rebuilt for every case, and registers the mock
 * with vi.doMock so the next dynamic import sees it.
 */
import { vi } from "vitest";

export const DUMMY_GEMINI_API_KEY = "test-gemini-key";

/** A response that passes AITurnResponseSchema. */
export function validTurn(overrides: Record<string, unknown> = {}) {
  return {
    reply: "Thank you. Who are you calling for?",
    risk_score: 10,
    flags: [],
    claimed_identity: null,
    claims_family: false,
    requested_amount: null,
    payment_method: null,
    summary: "Caller introduced themselves.",
    ...overrides,
  };
}

export interface GeminiMock {
  /** The mocked `models.generateContent`. Inspect `.mock.calls` for the request. */
  generateContent: ReturnType<typeof vi.fn>;
  /** Resolve with `{ text: JSON.stringify(body) }`. */
  respondWith(body: unknown): void;
  /** Resolve with raw text (use for invalid JSON, empty string, etc.). */
  respondWithText(text: string): void;
  /** Reject with an error. */
  failWith(error?: Error): void;
  /**
   * Never answer on its own: resolves with `body` after `delayMs`, but rejects
   * with an AbortError as soon as `config.abortSignal` fires (like the real SDK).
   */
  respondSlowly(body?: unknown, delayMs?: number): void;
  /** Restore env and mocks. */
  restore(): void;
}

export function installGeminiMock(): GeminiMock {
  const savedKey = process.env.GEMINI_API_KEY;
  const savedProvider = process.env.AI_PROVIDER;

  vi.resetModules(); // getAI() is a singleton; force a fresh one per case
  process.env.GEMINI_API_KEY = DUMMY_GEMINI_API_KEY;
  delete process.env.AI_PROVIDER; // defaults to gemini

  const generateContent = vi.fn();

  vi.doMock("@google/genai", () => ({
    GoogleGenAI: class {
      models = { generateContent };
    },
  }));

  return {
    generateContent,
    respondWith(body) {
      generateContent.mockReset();
      generateContent.mockResolvedValue({ text: JSON.stringify(body) });
    },
    respondWithText(text) {
      generateContent.mockReset();
      generateContent.mockResolvedValue({ text });
    },
    failWith(error = new Error("Gemini mock: upstream failure")) {
      generateContent.mockReset();
      generateContent.mockRejectedValue(error);
    },
    respondSlowly(body = validTurn(), delayMs = 60_000) {
      generateContent.mockReset();
      generateContent.mockImplementation(
        (req: { config?: { abortSignal?: AbortSignal } }) =>
          new Promise((resolve, reject) => {
            const signal = req?.config?.abortSignal;
            const timer = setTimeout(
              () => resolve({ text: JSON.stringify(body) }),
              delayMs,
            );
            const abort = () => {
              clearTimeout(timer);
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          }),
      );
    },
    restore() {
      vi.doUnmock("@google/genai");
      vi.restoreAllMocks();
      if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedKey;
      if (savedProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = savedProvider;
      vi.resetModules();
    },
  };
}
