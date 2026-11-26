import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGeminiMock, validTurn } from "./helpers/gemini";
import type { GeminiMock } from "./helpers/gemini";
import { callFixture, householdFixture, parseTwiml } from "./helpers/voice";
import type { CallEventRow } from "@/lib/db";

const FAMILY = "Testerson";

const state = vi.hoisted(() => ({
  events: [] as any[],
  household: null as any,
  callOverride: {} as Record<string, unknown>,
}));

vi.mock("@/lib/db", () => ({
  getCallBySid: vi.fn(async () => ({ ...callFixture(), is_simulated: true, ...state.callOverride })),
  getHousehold: vi.fn(async () => state.household),
  getCallEvents: vi.fn(async () => state.events),
  updateCall: vi.fn(async () => undefined),
  appendEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/alerts", () => ({ sendAlerts: vi.fn(async () => undefined) }));

const START = new Date("2026-01-01T00:00:00.000Z");
const HIGH_SPEECH = "Buy gift cards right now, this is the CRA";
const MEDIUM_SPEECH = "I need a gift card";

function callerEvent(text: string) {
  return { type: "transcript", payload: { speaker: "caller", text }, created_at: START.toISOString() };
}

function entryEvent(): Pick<CallEventRow, "type" | "payload" | "created_at"> {
  return {
    type: "state_change",
    payload: { from: "screening", to: "time_wasted", started_at: START.toISOString() },
    created_at: START.toISOString(),
  };
}

function wordCount(s: string) {
  return s.trim().split(/\s+/).length;
}

let gemini: GeminiMock;

async function runTurn(speech: string, currentState: "screening" | "time_wasted", score = 0) {
  const { engine } = await import("@/lib/conversation");
  return engine({ callSid: "CA_TEST_0001", speechResult: speech, currentState, currentRiskScore: score });
}

function systemInstruction(callIndex: number): string {
  return gemini.generateContent.mock.calls[callIndex]![0].config.systemInstruction as string;
}

beforeEach(() => {
  gemini = installGeminiMock();
  vi.useFakeTimers();
  vi.setSystemTime(START);
  state.events = [];
  state.callOverride = {};
  state.household = { ...householdFixture(), family_name: FAMILY, time_waster_enabled: true };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  gemini.restore();
});

describe("persona switch", () => {
  it("rules HIGH with the setting on moves to time_wasted with a short grandmother reply", async () => {
    gemini.respondWith(validTurn({ reply: "Oh dear, where are my glasses?", risk_score: 0 }));
    state.events = [callerEvent(HIGH_SPEECH)];

    const out = await runTurn(HIGH_SPEECH, "screening");

    expect(out.nextState).toBe("time_wasted");
    expect(out.riskUpdate.level).toBe("high");
    expect(out.reply).toBe("Oh dear, where are my glasses?");
    expect(wordCount(out.reply)).toBeLessThan(20);
    expect(out.stateChangeExtra).toEqual({ started_at: START.toISOString() });
    expect(out.hangup).toBeUndefined();
    // The entry turn already used the persona prompt.
    expect(systemInstruction(0)).toContain("Marmalade");
  });

  it("MEDIUM (gift card only) does not switch", async () => {
    gemini.respondWith(validTurn());
    state.events = [callerEvent(MEDIUM_SPEECH)];

    const out = await runTurn(MEDIUM_SPEECH, "screening");

    expect(out.riskUpdate.level).toBe("medium");
    expect(out.nextState).not.toBe("time_wasted");
    expect(out.stateChangeExtra).toBeUndefined();
    expect(systemInstruction(0)).not.toContain("Marmalade");
    expect(systemInstruction(0)).toContain(FAMILY);
  });

  it("next turn calls Gemini with inTimeWaster: true and a persona prompt without family name or scam", async () => {
    gemini.respondWith(validTurn({ reply: "Pardon, dear? Marmalade is on my lap.", risk_score: 90 }));
    const ai = await import("@/lib/scoring/ai");
    const spy = vi.spyOn(ai, "callGemini");
    state.events = [entryEvent(), callerEvent("Pay now")];
    vi.setSystemTime(new Date(START.getTime() + 1000));

    const out = await runTurn("Pay now", "time_wasted", 90);

    expect(out.nextState).toBe("time_wasted");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![3]).toBe(true);
    const prompt = systemInstruction(0);
    expect(prompt).toContain("Marmalade");
    expect(prompt).toContain("glasses");
    expect(prompt).not.toContain(FAMILY);
    expect(prompt.toLowerCase()).not.toContain("scam");
  });

  it("AI alone raising to HIGH gives ENTRY_LINE and a single Gemini call", async () => {
    const { ENTRY_LINE } = await import("@/lib/time-waster");
    gemini.respondWith(validTurn({ reply: "Thank you. Who are you calling for?", risk_score: 90 }));
    state.events = [callerEvent("Hello there")];

    const out = await runTurn("Hello there", "screening");

    expect(gemini.generateContent).toHaveBeenCalledTimes(1);
    expect(systemInstruction(0)).not.toContain("Marmalade");
    expect(out.nextState).toBe("time_wasted");
    expect(out.reply).toBe(ENTRY_LINE);
    expect(out.stateChangeExtra).toEqual({ started_at: START.toISOString() });
  });
});

describe("time limit", () => {
  async function turnAt(seconds: number) {
    const ai = await import("@/lib/scoring/ai");
    const spy = vi.spyOn(ai, "callGemini");
    state.events = [entryEvent(), callerEvent("Pay now")];
    vi.setSystemTime(new Date(START.getTime() + seconds * 1000));
    const out = await runTurn("Pay now", "time_wasted", 90);
    return { out, spy };
  }

  it("limit 5: at 4 s the reply is still a grandmother reply", async () => {
    vi.stubEnv("TIME_WASTER_SECONDS", "5");
    gemini.respondWith(validTurn({ reply: "Pardon, dear? Marmalade is on my lap.", risk_score: 90 }));
    const { out, spy } = await turnAt(4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.nextState).toBe("time_wasted");
    expect(out.hangup).toBeUndefined();
    expect(out.reply).toBe("Pardon, dear? Marmalade is on my lap.");
  });

  it.each([5, 6])("limit 5: at %i s the call ends, Gemini is not called", async (s) => {
    vi.stubEnv("TIME_WASTER_SECONDS", "5");
    gemini.respondWith(validTurn({ risk_score: 90 }));
    const { GOODBYE_LINE } = await import("@/lib/time-waster");
    const { out, spy } = await turnAt(s);
    expect(spy).not.toHaveBeenCalled();
    expect(gemini.generateContent).not.toHaveBeenCalled();
    expect(out.reply).toBe(GOODBYE_LINE);
    expect(out.hangup).toBe(true);
    expect(out.nextState).toBe("completed");
    expect(out.outcome).toBe("time_wasted");
  });

  it("limit 5: processTurn and the turn route answer Say then Hangup", async () => {
    vi.stubEnv("TIME_WASTER_SECONDS", "5");
    gemini.respondWith(validTurn({ risk_score: 90 }));
    state.callOverride = { state: "time_wasted", risk_score: 90, risk_level: "high" };
    state.events = [entryEvent()];
    vi.setSystemTime(new Date(START.getTime() + 5000));
    const { processTurn } = await import("@/lib/turn");
    const { goodbyeTwiml } = await import("@/lib/twiml");
    const { GOODBYE_LINE } = await import("@/lib/time-waster");

    const result = await processTurn({ callSid: "CA_TEST_0001", speech: "Pay now", source: "twilio" });
    expect(result).toMatchObject({ kind: "turn", hangup: true, nextState: "completed", reply: GOODBYE_LINE });
    expect(gemini.generateContent).not.toHaveBeenCalled();

    // The route maps hangup to goodbyeTwiml(reply).
    expect(parseTwiml(goodbyeTwiml(GOODBYE_LINE))).toEqual(["Say", "Hangup"]);
  });

  it("default limit: 179 s continues, 180 s ends", async () => {
    gemini.respondWith(validTurn({ reply: "Pardon, dear?", risk_score: 90 }));
    expect((await turnAt(179)).out.hangup).toBeUndefined();
    expect((await turnAt(180)).out.hangup).toBe(true);
  });

  it("999 is clamped to 180", async () => {
    vi.stubEnv("TIME_WASTER_SECONDS", "999");
    gemini.respondWith(validTurn({ reply: "Pardon, dear?", risk_score: 90 }));
    expect((await turnAt(179)).out.hangup).toBeUndefined();
    expect((await turnAt(180)).out.hangup).toBe(true);
  });

  it.each(["abc", "0"])("%j falls back to 180", async (raw) => {
    vi.stubEnv("TIME_WASTER_SECONDS", raw);
    gemini.respondWith(validTurn({ reply: "Pardon, dear?", risk_score: 90 }));
    expect((await turnAt(179)).out.hangup).toBeUndefined();
    expect((await turnAt(180)).out.hangup).toBe(true);
  });
});

describe("events", () => {
  async function stateChanges() {
    const db = await import("@/lib/db");
    return vi
      .mocked(db.appendEvent)
      .mock.calls.map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "state_change");
  }

  async function turn(speech: string) {
    const { processTurn } = await import("@/lib/turn");
    return processTurn({ callSid: "CA_TEST_0001", speech, source: "twilio" });
  }

  it("entry event is state_change screening -> time_wasted with started_at, written once", async () => {
    gemini.respondWith(validTurn({ reply: "Oh dear, where are my glasses?", risk_score: 0 }));
    state.events = [callerEvent(HIGH_SPEECH)];

    await turn(HIGH_SPEECH);

    const changes = await stateChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toEqual({
      type: "state_change",
      from: "screening",
      to: "time_wasted",
      started_at: START.toISOString(),
    });
  });

  it("exit event after the limit carries from, to, started_at, ended_at, seconds and reason; written once", async () => {
    gemini.respondWith(validTurn({ risk_score: 90 }));
    state.callOverride = { state: "time_wasted", risk_score: 90, risk_level: "high" };
    state.events = [entryEvent()];
    vi.setSystemTime(new Date(START.getTime() + 180_000));

    await turn("Pay now");

    const changes = await stateChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toEqual({
      type: "state_change",
      from: "time_wasted",
      to: "completed",
      started_at: START.toISOString(),
      ended_at: new Date(START.getTime() + 180_000).toISOString(),
      seconds: 180,
      reason: "limit",
    });
  });

  it("exit seconds equal the configured limit", async () => {
    vi.stubEnv("TIME_WASTER_SECONDS", "5");
    gemini.respondWith(validTurn({ risk_score: 90 }));
    state.callOverride = { state: "time_wasted", risk_score: 90, risk_level: "high" };
    state.events = [entryEvent()];
    vi.setSystemTime(new Date(START.getTime() + 5000));

    await turn("Pay now");

    const changes = await stateChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ seconds: 5, reason: "limit" });
  });

  it("timeWastedSummary is running before the exit event and stops after it; formatMmSs(180) is 03:00", async () => {
    const { timeWastedSummary, formatMmSs } = await import("@/lib/time-waster");
    const now = new Date(START.getTime() + 10_000);

    expect(timeWastedSummary([entryEvent()], now)).toMatchObject({ running: true, seconds: 10 });

    const exit: Pick<CallEventRow, "type" | "payload" | "created_at"> = {
      type: "state_change",
      payload: { from: "time_wasted", to: "completed", ended_at: new Date(START.getTime() + 5000).toISOString() },
      created_at: new Date(START.getTime() + 5000).toISOString(),
    };
    expect(timeWastedSummary([entryEvent(), exit], now)).toMatchObject({ running: false, seconds: 5 });
    expect(formatMmSs(180)).toBe("03:00");
  });
});

describe("time waster disabled", () => {
  it("HIGH with time_waster_enabled false blocks: no persona, block line, alert still sent once", async () => {
    state.household = { ...householdFixture(), family_name: FAMILY, time_waster_enabled: false };
    gemini.respondWith(validTurn({ reply: "Oh dear, where are my glasses? Marmalade!", risk_score: 0 }));
    state.events = [callerEvent(HIGH_SPEECH)];

    const db = await import("@/lib/db");
    const alerts = await import("@/lib/alerts");
    const { processTurn } = await import("@/lib/turn");
    const { blockTwiml, goodbyeTwiml } = await import("@/lib/twiml");
    const { finalizeCall } = await import("@/lib/finalize-call");

    const result = await processTurn({ callSid: "CA_TEST_0001", speech: HIGH_SPEECH, source: "twilio" });
    if (result.kind !== "turn") throw new Error("expected a turn result");

    expect(result.nextState).toBe("scam_blocked");
    expect(result.riskLevel).toBe("high");
    expect(result.hangup).toBe(true);
    expect(systemInstruction(0)).not.toContain("Marmalade");

    // Outcome and state written to the call.
    expect(vi.mocked(db.updateCall).mock.calls.at(-1)![1]).toMatchObject({
      state: "scam_blocked",
      outcome: "blocked",
    });

    // The route answers with goodbyeTwiml(reply) for hangup: it must be the block line.
    const xml = goodbyeTwiml(result.reply);
    expect(xml).toBe(blockTwiml());
    expect(xml).toContain("I'm not able to connect this call. Goodbye.");
    expect(xml).toContain("<Hangup/>");
    expect(parseTwiml(xml)).toEqual(["Say", "Hangup"]);
    expect(xml).not.toContain("glasses");
    expect(xml).not.toContain("Marmalade");

    // No persona entry event.
    const changes = vi
      .mocked(db.appendEvent)
      .mock.calls.map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "state_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.payload).toMatchObject({ from: "screening", to: "scam_blocked" });
    expect(changes.some((e) => e.payload["to"] === "time_wasted")).toBe(false);

    // The end-of-call hook still alerts the family exactly once.
    await finalizeCall({ ...result.call, risk_level: "high", outcome: "blocked" } as any, {
      state: "scam_blocked",
      outcome: "blocked",
    });
    expect(alerts.sendAlerts).toHaveBeenCalledTimes(1);
  });
});
