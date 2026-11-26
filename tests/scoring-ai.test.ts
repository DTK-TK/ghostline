import { describe, it, expect, vi, beforeEach } from "vitest";

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

import { GeminiAI } from "@/lib/providers/ai";

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
