import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { scoreRules } from "@/lib/scoring/rules";
import { combineScores } from "@/lib/scoring/combine";

const NUM_RUNS = 200;

const PAYMENT = ["gift card", "Bitcoin", "wire transfer", "Western Union", "Google Play card"];
const URGENCY = ["right now", "immediately", "tonight", "before it's too late", "ASAP"];
const OTHER = [
  "this is the CRA calling",
  "don't tell anyone",
  "grandma I was in an accident",
  "install AnyDesk",
  "hello there",
  "I am calling about your car warranty",
];

const phrase = (list: string[]) => fc.constantFrom(...list);
const utterance = fc.oneof(fc.string({ maxLength: 40 }), phrase(PAYMENT), phrase(URGENCY), phrase(OTHER));
const transcript = fc.array(utterance, { maxLength: 8 });

const score0to300 = fc.integer({ min: 0, max: 300 });

describe("scoring properties", () => {
  it("(a) rules score never decreases when utterances are appended", () => {
    // **Validates: Requirements 3**
    fc.assert(
      fc.property(transcript, transcript, (base, extra) => {
        const before = scoreRules(base).score;
        const after = scoreRules([...base, ...extra]).score;
        expect(after).toBeGreaterThanOrEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(b) payment + urgency signals score at least 60 and at least MEDIUM", () => {
    // **Validates: Requirements 3, 5**
    fc.assert(
      fc.property(
        transcript,
        transcript,
        transcript,
        phrase(PAYMENT),
        phrase(URGENCY),
        fc.boolean(),
        (a, b, c, pay, urg, payFirst) => {
          const mid = payFirst ? [pay, ...b, urg] : [urg, ...b, pay];
          const rules = scoreRules([...a, ...mid, ...c]);
          expect(rules.score).toBeGreaterThanOrEqual(60);
          const result = combineScores({
            rulesScore: rules.score,
            aiScore: 0,
            allFlags: rules.flags,
            safeWordCorrect: false,
            callbackDenied: false,
            priorScore: 0,
          });
          expect(["medium", "high"]).toContain(result.level);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("(c) callbackDenied is always HIGH, even with a correct safe word", () => {
    // **Validates: Requirements 5**
    fc.assert(
      fc.property(
        score0to300,
        score0to300,
        fc.boolean(),
        fc.integer({ min: 0, max: 100 }),
        fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }),
        (rulesScore, aiScore, safeWordCorrect, priorScore, allFlags) => {
          const result = combineScores({
            rulesScore,
            aiScore,
            allFlags,
            safeWordCorrect,
            callbackDenied: true,
            priorScore,
          });
          expect(result.level).toBe("high");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("(d) without safe word, score >= min(100, rulesScore) and is monotonic in aiScore", () => {
    // **Validates: Requirements 5**
    fc.assert(
      fc.property(
        score0to300,
        score0to300,
        score0to300,
        fc.boolean(),
        fc.integer({ min: 0, max: 100 }),
        (rulesScore, ai1, ai2, callbackDenied, priorScore) => {
          const [lo, hi] = ai1 <= ai2 ? [ai1, ai2] : [ai2, ai1];
          const base = { rulesScore, allFlags: [], safeWordCorrect: false, callbackDenied, priorScore };
          const rLo = combineScores({ ...base, aiScore: lo });
          const rHi = combineScores({ ...base, aiScore: hi });
          expect(rLo.score).toBeGreaterThanOrEqual(Math.min(100, rulesScore));
          expect(rHi.score).toBeGreaterThanOrEqual(Math.min(100, rulesScore));
          expect(rHi.score).toBeGreaterThanOrEqual(rLo.score);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
