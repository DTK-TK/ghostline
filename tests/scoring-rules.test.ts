import { describe, it, expect } from "vitest";
import { scoreRules } from "@/lib/scoring/rules";

const POINTS: Record<string, number> = {
  payment_method: 40,
  secrecy: 30,
  authority: 30,
  emergency_story: 25,
  urgency: 20,
  remote_access: 30,
};

// Example signals from scam-rules.md. Bare "wire" and "courier" need money context (R3).
const SIGNALS: Record<string, string[]> = {
  payment_method: [
    "gift card",
    "iTunes",
    "Google Play",
    "bitcoin",
    "crypto",
    "wire the money tonight",
    "Western Union",
    "a courier will pick up the cash",
    "someone will pick it up",
  ],
  secrecy: ["don't tell mom", "don't tell dad", "keep this between us", "don't call anyone"],
  authority: ["bank", "CRA", "police", "RCMP", "lawyer", "court", "Microsoft support"],
  emergency_story: ["jail", "arrested", "bail", "accident", "hospital", "kidnapped"],
  urgency: ["right now", "tonight", "immediately", "before it's too late"],
  remote_access: ["install", "AnyDesk", "TeamViewer", "give me the code"],
};

describe("scoreRules", () => {
  for (const [flag, phrases] of Object.entries(SIGNALS)) {
    it.each(phrases)(`"%s" triggers ${flag}`, (phrase) => {
      const r = scoreRules([`Hello, this is Pat Example. ${phrase}.`]);
      expect(r.flags).toContain(flag);
    });
  }

  it.each([
    ["the courier is dropping off your parcel today"],
    ["your bank called about your appointment"],
    ["I need to wire the new lamp in the hall"],
  ])("stays LOW: %s", (text) => {
    expect(scoreRules([text]).score).toBeLessThan(40);
  });

  it("bare courier and bare wire do not flag payment_method", () => {
    expect(scoreRules(["the courier is dropping off your parcel today"]).flags).toEqual([]);
    expect(scoreRules(["your bank called about your appointment"]).flags).toEqual(["authority"]);
    expect(scoreRules(["wire the money tonight"]).flags).toContain("payment_method");
    expect(scoreRules(["a courier will pick up the cash"]).flags).toContain("payment_method");
  });

  it("courier pick up needs money context", () => {
    const parcel = scoreRules(["a courier will pick up the parcel"]);
    expect(parcel.flags).not.toContain("payment_method");
    expect(parcel.score).toBeLessThan(40);
    expect(scoreRules(["a courier will pick up the cash"]).flags).toContain("payment_method");
  });

  it("money context must be in the same caller turn", () => {
    expect(scoreRules(["the courier is here", "I have the cash"]).flags).not.toContain("payment_method");
    expect(scoreRules(["I will wire", "send the money"]).flags).not.toContain("payment_method");
  });

  it("returns zero for an empty transcript", () => {
    expect(scoreRules([])).toEqual({ score: 0, flags: [] });
  });

  it("fires each flag once however often it repeats", () => {
    const r = scoreRules(["gift card", "gift card again", "bitcoin gift card"]);
    expect(r.flags).toEqual(["payment_method"]);
    expect(r.score).toBe(POINTS.payment_method);
  });

  it("sums the weights of distinct flags", () => {
    const r = scoreRules(["Buy a gift card right now and don't tell mom"]);
    expect(r.flags.sort()).toEqual(["payment_method", "secrecy", "urgency"]);
    expect(r.score).toBe(40 + 30 + 20);
  });

  it("is deterministic", () => {
    const t = ["police arrested your grandson, pay bail tonight"];
    expect(scoreRules(t)).toEqual(scoreRules(t));
  });

  it.each([
    "Hi, this is Dr. Lee's office calling to confirm your appointment on Tuesday.",
    "Your prescription is ready for pickup at the pharmacy.",
    "I have a delivery for the Smith residence, can someone sign?",
    "Hi, I'm your neighbour Sam, just checking you got the mail.",
  ])("legitimate speech stays below MEDIUM: %s", (text) => {
    expect(scoreRules([text]).score).toBeLessThan(40);
  });
});
