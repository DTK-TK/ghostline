import { describe, it, expect } from "vitest";
import { scoreRules } from "@/lib/scoring/rules";
import { combineScores } from "@/lib/scoring/combine";
import scams from "./fixtures/scams.json";
import legitimate from "./fixtures/legitimate.json";

interface Fixture {
  id: string;
  category: string;
  caller: string[];
  safeWordCorrect?: boolean;
  expectedLevel: "low" | "medium" | "high";
  knownGap?: boolean;
  reason?: string;
}

function levelFor(f: Fixture) {
  const rules = scoreRules(f.caller);
  return combineScores({
    rulesScore: rules.score,
    aiScore: 0,
    allFlags: rules.flags,
    safeWordCorrect: f.safeWordCorrect ?? false,
    callbackDenied: false,
    priorScore: 0,
  });
}

function run(name: string, fixtures: Fixture[]) {
  describe(name, () => {
    for (const f of fixtures) {
      const body = () => {
        const result = levelFor(f);
        expect(result.level, `${f.id}: score ${result.score}, flags ${result.flags.join(",")}`).toBe(
          f.expectedLevel,
        );
      };
      // knownGap cases must fail today; when the rules improve they flip and
      // it.fails reports it, prompting removal of the knownGap mark.
      if (f.knownGap) {
        it.fails(`${f.id} [knownGap: ${f.reason}]`, body);
      } else {
        it(`${f.id} is ${f.expectedLevel}`, body);
      }
    }
  });
}

run("scam fixtures", scams as Fixture[]);
run("legitimate fixtures", legitimate as Fixture[]);

describe("fixture set", () => {
  it("has 30 cases", () => {
    expect(scams.length + legitimate.length).toBe(30);
  });
});
