import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installGeminiMock, validTurn, type GeminiMock } from "./helpers/gemini";

const ctx = { familyName: "Smith", inTimeWaster: false };

describe("Gemini mock helper", () => {
  let gemini: GeminiMock;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    gemini = installGeminiMock();
  });

  afterEach(() => {
    // Checked before restore() clears spies.
    expect(fetchSpy).not.toHaveBeenCalled();
    gemini.restore();
  });

  async function load() {
    return import("@/lib/providers/ai");
  }

  it("returns a validated turn on success JSON", async () => {
    gemini.respondWith(validTurn({ flags: ["urgency", "made_up"] }));
    const { GeminiAI } = await load();
    const out = await new GeminiAI().generateTurn([], "Hello", ctx);
    expect(out.reply).toMatch(/Who are you calling for/);
    expect(out.flags).toEqual(["urgency"]);
    expect(gemini.generateContent).toHaveBeenCalledTimes(1);
  });

  it("raises AIUnavailableError on invalid JSON", async () => {
    gemini.respondWithText("not json {");
    const { GeminiAI, AIUnavailableError } = await load();
    await expect(new GeminiAI().generateTurn([], "Hello", ctx)).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
  });

  it("raises AIUnavailableError when Gemini throws", async () => {
    gemini.failWith(new Error("boom"));
    const { GeminiAI, AIUnavailableError } = await load();
    await expect(new GeminiAI().generateTurn([], "Hello", ctx)).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
  });

  it("raises AIUnavailableError when the response is slower than the abort signal", async () => {
    gemini.respondSlowly();
    // Shorten the provider's 6 s timeout so the test stays fast.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(), 20);
      void ms;
      return c.signal;
    });
    const { GeminiAI, AIUnavailableError } = await load();
    await expect(new GeminiAI().generateTurn([], "Hello", ctx)).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
  });

  it("resets modules between cases so the dummy key is applied fresh", async () => {
    expect(process.env.GEMINI_API_KEY).toBe("test-gemini-key");
    expect(process.env.AI_PROVIDER).toBeUndefined();
    gemini.respondWith(validTurn());
    const { getAI } = await import("@/lib/providers");
    const out = await getAI().generateTurn([], "Hi", ctx);
    expect(out.risk_score).toBe(10);
  });
});
