import { describe, it, expect, vi, beforeEach } from "vitest";

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

import { GeminiAI, AIUnavailableError } from "@/lib/providers/ai";

const validResponse = {
  reply: "Thank you. Who are you calling for?",
  risk_score: 10,
  flags: [],
  claimed_identity: null,
  claims_family: false,
  requested_amount: null,
  payment_method: null,
  summary: "Caller introduced themselves.",
};

describe("GeminiAI flag filtering", () => {
  beforeEach(() => {
    generateContent.mockReset();
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("drops unknown flag ids and keeps known ones", async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({ ...validResponse, flags: ["made_up", "urgency", "secrecy"] }),
    });
    const out = await new GeminiAI().generateTurn([], "Hi", {
      familyName: "Smith",
      inTimeWaster: false,
    });
    expect(out.flags).toEqual(["urgency", "secrecy"]);
  });
});

describe("GeminiAI system prompt", () => {
  beforeEach(() => {
    generateContent.mockReset();
    generateContent.mockResolvedValue({ text: JSON.stringify(validResponse) });
    process.env.GEMINI_API_KEY = "test-key";
  });

  it.each([false, true])(
    "does not contain the opening line (inTimeWaster=%s) but keeps persona rules",
    async (inTimeWaster) => {
      await new GeminiAI().generateTurn([], "Hi, it's Bob", {
        familyName: "Smith",
        inTimeWaster,
      });

      const instruction: string =
        generateContent.mock.calls[0]![0].config.systemInstruction;
      expect(instruction).not.toContain("This call is screened by Ghostline");
      expect(instruction).not.toContain("You've reached the");
      expect(instruction).toContain("PERSONA RULES");
      expect(instruction).toContain("Never accuse anyone of being a scammer");
      expect(instruction).toContain("Smith");
    },
  );
});

describe("GeminiAI request config and failure handling", () => {
  const ctx = { familyName: "Smith", inTimeWaster: false };

  beforeEach(() => {
    generateContent.mockReset();
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("requests JSON output, the flash model and an abort signal", async () => {
    generateContent.mockResolvedValue({ text: JSON.stringify(validResponse) });
    await new GeminiAI().generateTurn([], "Hi", ctx);
    const req = generateContent.mock.calls[0]![0];
    expect(req.model).toBe("gemini-2.5-flash");
    expect(req.config.responseMimeType).toBe("application/json");
    expect(req.config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("throws AIUnavailableError when zod validation fails", async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({ ...validResponse, risk_score: 150 }),
    });
    await expect(new GeminiAI().generateTurn([], "Hi", ctx)).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
  });

  it("throws AIUnavailableError on invalid JSON", async () => {
    generateContent.mockResolvedValue({ text: "not json" });
    await expect(new GeminiAI().generateTurn([], "Hi", ctx)).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
  });

  it("throws AIUnavailableError when the abort signal fires (timeout)", async () => {
    // AbortSignal.timeout uses an internal timer that fake timers do not
    // control, so capture the requested delay and fire the abort ourselves.
    const controller = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    try {
      generateContent.mockImplementation(
        (req: { config: { abortSignal: AbortSignal } }) =>
          new Promise((_resolve, reject) => {
            req.config.abortSignal.addEventListener("abort", () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      );
      const result = new GeminiAI().generateTurn([], "Hi", ctx).then(
        () => null,
        (e: unknown) => e,
      );
      expect(timeoutSpy).toHaveBeenCalledWith(6000);
      controller.abort();
      expect(await result).toBeInstanceOf(AIUnavailableError);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
