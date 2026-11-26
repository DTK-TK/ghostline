import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { combineScores, scoreToLevel, type CombineInput } from "@/lib/scoring/combine";

const base: CombineInput = {
  rulesScore: 0,
  aiScore: 0,
  allFlags: [],
  safeWordCorrect: false,
  callbackDenied: false,
  priorScore: 0,
};
const run = (o: Partial<CombineInput>) => combineScores({ ...base, ...o });

describe("combineScores (R5)", () => {
  describe("step 1: max of rules and AI", () => {
    it("takes the rules score when it is higher", () => {
      expect(run({ rulesScore: 60, aiScore: 20 }).score).toBe(60);
    });
    it("takes the AI score when it is higher (AI can raise)", () => {
      expect(run({ rulesScore: 20, aiScore: 75 }).score).toBe(75);
    });
    it("AI score of 0 never lowers the rules score", () => {
      expect(run({ rulesScore: 55, aiScore: 0 }).score).toBe(55);
    });
  });

  describe("step 2: callback_denied", () => {
    it("adds 100 and yields HIGH, capped at 100", () => {
      const r = run({ rulesScore: 10, callbackDenied: true });
      expect(r.score).toBe(100);
      expect(r.level).toBe("high");
    });
    it("yields HIGH even from a zero score", () => {
      expect(run({ callbackDenied: true }).level).toBe("high");
    });
  });

  describe("step 3: safe word", () => {
    it("subtracts 40", () => {
      expect(run({ rulesScore: 80, safeWordCorrect: true }).score).toBe(40);
    });
    it("floors at 0", () => {
      expect(run({ rulesScore: 25, safeWordCorrect: true }).score).toBe(0);
    });
    it("never cancels callback_denied", () => {
      const r = run({ rulesScore: 30, safeWordCorrect: true, callbackDenied: true });
      expect(r.score).toBe(100);
      expect(r.level).toBe("high");
    });
    it("is not applied when the safe word is wrong", () => {
      expect(run({ rulesScore: 80, safeWordCorrect: false }).score).toBe(80);
    });
  });

  describe("step 4: monotonic floor", () => {
    it("never goes below priorScore", () => {
      expect(run({ rulesScore: 10, priorScore: 65 }).score).toBe(65);
    });
    it("floor applies after safe-word credit", () => {
      expect(run({ rulesScore: 80, safeWordCorrect: true, priorScore: 80 }).score).toBe(80);
    });
    it("does not lower a higher computed score", () => {
      expect(run({ rulesScore: 50, priorScore: 20 }).score).toBe(50);
    });
  });

  describe("step 5: cap", () => {
    it("caps at 100", () => {
      expect(run({ rulesScore: 250 }).score).toBe(100);
    });
    it("caps a priorScore above 100", () => {
      expect(run({ priorScore: 150 }).score).toBe(100);
    });
  });

  describe("band boundaries", () => {
    it.each([
      [0, "low"],
      [39, "low"],
      [40, "medium"],
      [69, "medium"],
      [70, "high"],
      [100, "high"],
    ] as const)("score %i is %s", (score, level) => {
      expect(scoreToLevel(score)).toBe(level);
      expect(run({ rulesScore: score }).level).toBe(level);
    });
  });

  describe("flags", () => {
    it("deduplicates flags", () => {
      expect(run({ allFlags: ["urgency", "secrecy", "urgency"] }).flags).toEqual([
        "urgency",
        "secrecy",
      ]);
    });
  });

  describe("properties", () => {
    // **Validates: Requirements 5**
    it("score is within 0..100, >= priorScore (when <=100), and denial is always HIGH", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 300 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.boolean(),
          fc.boolean(),
          (rulesScore, aiScore, priorScore, safeWordCorrect, callbackDenied) => {
            const r = run({ rulesScore, aiScore, priorScore, safeWordCorrect, callbackDenied });
            expect(r.score).toBeGreaterThanOrEqual(0);
            expect(r.score).toBeLessThanOrEqual(100);
            expect(r.score).toBeGreaterThanOrEqual(priorScore);
            if (callbackDenied) expect(r.level).toBe("high");
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
