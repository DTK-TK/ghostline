/**
 * lib/simulator/scenarios.ts
 *
 * Simulator scenarios. Each scenario points at one of the 30 fixtures in
 * tests/fixtures/*.json (imported, never copied), so the demo and the test
 * suite share one source of caller lines.
 *
 * The server owns every line. The client sends only a scenario id and a step
 * index. The safe word is never stored here: a "correct" safe word step is
 * resolved from SIMULATOR_SAFE_WORD at run time (see run.ts).
 */

import scams from "@/tests/fixtures/scams.json";
import legitimate from "@/tests/fixtures/legitimate.json";

export type ExpectedLevel = "low" | "medium" | "high";
export type CallbackAnswer = "denied" | "confirmed" | "no_answer";

interface Fixture {
  id: string;
  category: string;
  caller: string[];
  expectedLevel: ExpectedLevel;
  safeWordCorrect?: boolean;
}

export type ScenarioLine =
  | { kind: "speech"; text: string; callbackAnswer?: CallbackAnswer }
  | { kind: "safe_word"; safeWord: "correct" | "wrong"; callbackAnswer?: CallbackAnswer };

export interface Scenario {
  id: string;
  label: string;
  fixtureId: string;
  expectedLevel: ExpectedLevel;
  lines: ScenarioLine[];
}

const FIXTURES: Fixture[] = [...(scams as Fixture[]), ...(legitimate as Fixture[])];

function fixture(id: string): Fixture {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`Simulator fixture not found: ${id}`);
  return f;
}

function fromFixture(
  id: string,
  label: string,
  fixtureId: string,
  extra: ScenarioLine[] = [],
): Scenario {
  const f = fixture(fixtureId);
  return {
    id,
    label,
    fixtureId,
    expectedLevel: f.expectedLevel,
    lines: [...f.caller.map((text): ScenarioLine => ({ kind: "speech", text })), ...extra],
  };
}

function withSafeWordAfterFirstLine(s: Scenario): Scenario {
  const [first, ...rest] = s.lines;
  return { ...s, lines: [first!, { kind: "safe_word", safeWord: "correct" }, ...rest] };
}

/** Scenario ids are lowercase letters only, so they survive inside a call sid. */
export const SCENARIOS: Record<string, Scenario> = {
  grandparent: fromFixture("grandparent", "Grandparent scam", "scam-grandparent-1"),
  cra: fromFixture("cra", "CRA tax scam", "scam-cra-1"),
  bank: fromFixture("bank", "Bank and tech support scam", "scam-bank-1"),
  doctor: fromFixture("doctor", "Legitimate doctor's office", "legit-doctor-1"),
  // The safe word follows the family claim, as a real grandchild would answer
  // the challenge. Appending it after the fixture lines would make the second
  // fixture line the (wrong) first attempt.
  grandchild: withSafeWordAfterFirstLine(
    fromFixture("grandchild", "Real grandchild with the safe word", "legit-grandchild-1"),
  ),
};

export function getScenario(id: string): Scenario | null {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, id) ? SCENARIOS[id]! : null;
}

export function listScenarios(): Array<Pick<Scenario, "id" | "label">> {
  return Object.values(SCENARIOS).map(({ id, label }) => ({ id, label }));
}
