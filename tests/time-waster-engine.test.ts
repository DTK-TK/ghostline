import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ENTRY_LINE, GOODBYE_LINE, GRANDMOTHER_LINES } from "@/lib/time-waster";

const state = vi.hoisted(() => ({
  events: [] as any[],
  household: { id: "hh-1", family_name: "Testerson", time_waster_enabled: true },
}));

vi.mock("@/lib/db", () => ({
  getCallBySid: vi.fn(async () => ({
    id: "call-1",
    household_id: "hh-1",
    claimed_identity: null,
    summary: null,
    risk_score: 90,
    risk_level: "high",
    is_simulated: true,
  })),
  getHousehold: vi.fn(async () => state.household),
  getCallEvents: vi.fn(async () => state.events),
  updateCall: vi.fn(async () => undefined),
  appendEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/alerts", () => ({ sendAlerts: vi.fn(async () => undefined) }));

const START = new Date("2026-01-01T00:00:00.000Z");
const HIGH_SPEECH = "Buy gift cards right now, this is the CRA";

function geminiReply(over: Record<string, unknown> = {}) {
  return {
    reply: "Thank you. Who are you calling for?",
    risk_score: 0,
    flags: [],
    claims_family: false,
    claimed_identity: null,
    summary: "",
    ...over,
  } as any;
}

function entryEvent() {
  return {
    type: "state_change",
    payload: { from: "screening", to: "time_wasted", started_at: START.toISOString() },
    created_at: START.toISOString(),
  };
}

async function setup(reply = geminiReply()) {
  const ai = await import("@/lib/scoring/ai");
  const spy = vi.spyOn(ai, "callGemini").mockResolvedValue(reply);
  const { engine } = await import("@/lib/conversation");
  return { spy, engine };
}

function callerEvent(text: string) {
  return { type: "transcript", payload: { speaker: "caller", text }, created_at: START.toISOString() };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(START);
  state.events = [];
  state.household = { id: "hh-1", family_name: "Testerson", time_waster_enabled: true };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("engine: time-waster persona switch", () => {
  it("rules HIGH enters the persona, passes inTimeWaster=true, uses a short AI reply", async () => {
    const { spy, engine } = await setup(geminiReply({ reply: "Oh dear, where are my glasses?" }));
    state.events = [callerEvent(HIGH_SPEECH)];
    const out = await engine({
      callSid: "CA1", speechResult: HIGH_SPEECH, currentState: "screening", currentRiskScore: 0,
    });
    expect(spy.mock.calls[0]![3]).toBe(true);
    expect(out.nextState).toBe("time_wasted");
    expect(out.reply).toBe("Oh dear, where are my glasses?");
    expect(out.stateChangeExtra).toEqual({ started_at: START.toISOString() });
    expect(out.hangup).toBeUndefined();
  });

  it("MEDIUM does not switch and does not pass the persona flag", async () => {
    const { spy, engine } = await setup();
    state.events = [callerEvent("I need a gift card")];
    const out = await engine({
      callSid: "CA1", speechResult: "I need a gift card", currentState: "screening", currentRiskScore: 0,
    });
    expect(spy.mock.calls[0]![3]).toBe(false);
    expect(out.nextState).not.toBe("time_wasted");
    expect(out.stateChangeExtra).toBeUndefined();
  });

  it("AI alone raising to HIGH gives ENTRY_LINE with one Gemini call", async () => {
    const { spy, engine } = await setup(geminiReply({ risk_score: 90 }));
    state.events = [callerEvent("hello")];
    const out = await engine({
      callSid: "CA1", speechResult: "hello", currentState: "screening", currentRiskScore: 0,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![3]).toBe(false);
    expect(out.nextState).toBe("time_wasted");
    expect(out.reply).toBe(ENTRY_LINE);
  });

  it("a 20-word persona reply is replaced by a scripted line", async () => {
    const long = Array(20).fill("dear").join(" ");
    const { engine } = await setup(geminiReply({ reply: long }));
    state.events = [entryEvent(), callerEvent("pay now")];
    vi.setSystemTime(new Date(START.getTime() + 1000));
    const out = await engine({
      callSid: "CA1", speechResult: "pay now", currentState: "time_wasted", currentRiskScore: 90,
    });
    expect(out.nextState).toBe("time_wasted");
    expect(out.stateChangeExtra).toBeUndefined();
    expect(GRANDMOTHER_LINES).toContain(out.reply);
  });

  it("falls back to a scripted line when Gemini is unavailable", async () => {
    const ai = await import("@/lib/scoring/ai");
    vi.spyOn(ai, "callGemini").mockRejectedValue(new ai.GeminiUnavailableError("down"));
    const { engine } = await import("@/lib/conversation");
    state.events = [callerEvent(HIGH_SPEECH)];
    const out = await engine({
      callSid: "CA1", speechResult: HIGH_SPEECH, currentState: "screening", currentRiskScore: 0,
    });
    expect(out.nextState).toBe("time_wasted");
    expect(out.reply).toBe(ENTRY_LINE);
  });
});

describe("engine: time-waster limit", () => {
  async function turnAt(seconds: number) {
    const { spy, engine } = await setup();
    state.events = [entryEvent(), callerEvent("pay now")];
    vi.setSystemTime(new Date(START.getTime() + seconds * 1000));
    const out = await engine({
      callSid: "CA1", speechResult: "pay now", currentState: "time_wasted", currentRiskScore: 90,
    });
    return { out, spy };
  }

  it("keeps going at 4 s with limit 5", async () => {
    vi.stubEnv("TIME_WASTER_SECONDS", "5");
    const { out } = await turnAt(4);
    expect(out.nextState).toBe("time_wasted");
    expect(out.hangup).toBeUndefined();
  });

  it.each([5, 6])("ends at %i s with limit 5 and skips Gemini", async (s) => {
    vi.stubEnv("TIME_WASTER_SECONDS", "5");
    const { out, spy } = await turnAt(s);
    expect(spy).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      reply: GOODBYE_LINE,
      hangup: true,
      nextState: "completed",
      outcome: "time_wasted",
      stateChangeExtra: {
        started_at: START.toISOString(),
        ended_at: new Date(START.getTime() + 5000).toISOString(),
        seconds: 5,
        reason: "limit",
      },
    });
  });

  it("defaults to 180 and clamps 999 to 180", async () => {
    expect((await turnAt(179)).out.nextState).toBe("time_wasted");
    vi.resetModules();
    expect((await turnAt(180)).out.hangup).toBe(true);
    vi.resetModules();
    vi.stubEnv("TIME_WASTER_SECONDS", "999");
    expect((await turnAt(179)).out.hangup).toBeUndefined();
    vi.resetModules();
    expect((await turnAt(180)).out.hangup).toBe(true);
  });

  it("property: the call ends exactly when elapsed >= limit", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 180 }), fc.integer({ min: 0, max: 200 }), async (limit, e) => {
        vi.resetModules();
        vi.stubEnv("TIME_WASTER_SECONDS", String(limit));
        const { out } = await turnAt(e);
        expect(out.hangup === true).toBe(e >= limit);
      }),
      { numRuns: 25 },
    );
  });
});

describe("engine: time-waster disabled", () => {
  it("HIGH with the setting off is a block with outcome blocked", async () => {
    state.household = { id: "hh-1", family_name: "Testerson", time_waster_enabled: false };
    const { spy, engine } = await setup();
    state.events = [callerEvent(HIGH_SPEECH)];
    const out = await engine({
      callSid: "CA1", speechResult: HIGH_SPEECH, currentState: "screening", currentRiskScore: 0,
    });
    expect(spy.mock.calls[0]![3]).toBe(false);
    expect(out).toMatchObject({ nextState: "scam_blocked", outcome: "blocked", hangup: true });
    expect(out.stateChangeExtra).toBeUndefined();
  });
});
