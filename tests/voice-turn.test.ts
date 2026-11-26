import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BASE_URL, twilioRequest, parseTwiml, householdFixture, callFixture } from "./helpers/voice";

const db = vi.hoisted(() => ({
  getCallBySid: vi.fn(),
  getHousehold: vi.fn(),
  updateCall: vi.fn(),
  appendEvent: vi.fn(),
  getCallEvents: vi.fn(),
}));
const engine = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => db);
vi.mock("@/lib/conversation", () => ({ engine }));

import { POST } from "@/app/api/voice/turn/route";

const SPEECH = { CallSid: "CA_TEST_0001", From: "+15550009999", To: "+15550000000", SpeechResult: "Hi, I am calling about my appointment", Digits: "" };

function turn(params: Record<string, string> = SPEECH) {
  return POST(twilioRequest("/api/voice/turn", params));
}

function engineReturns(nextState: string, level = "low", score = 0, reply = "Thank you. Could you tell me more?") {
  engine.mockResolvedValue({ reply, nextState, riskUpdate: { score, level } });
}

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", BASE_URL);
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+15550001111");
  db.getCallBySid.mockResolvedValue(callFixture());
  db.getHousehold.mockResolvedValue(householdFixture());
  db.updateCall.mockResolvedValue({});
  db.appendEvent.mockResolvedValue({});
  db.getCallEvents.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/voice/turn: nextState to TwiML", () => {
  it("screening: speaks the reply, gathers speech, redirects back to /turn", async () => {
    engineReturns("screening", "low", 0, "Could you tell me more?");

    const res = await turn();
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(xml).toContain('input="speech"');
    expect(xml).toContain(`action="${BASE_URL}/api/voice/turn"`);
    expect(xml).toContain("Could you tell me more?");
  });

  it("initiated: keeps gathering, same as screening", async () => {
    db.getCallBySid.mockResolvedValue(callFixture({ state: "initiated" }));
    engineReturns("initiated");

    expect(parseTwiml(await (await turn()).text())).toEqual(["Gather", "Say", "Redirect"]);
  });

  it("time_wasted: keeps gathering with the grandmother line", async () => {
    engineReturns("time_wasted", "high", 80, "Oh dear, where are my glasses?");

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(xml).toContain("Oh dear, where are my glasses?");
  });

  it("callback just started: holds the caller (Say, Pause 10, Redirect hold-check?n=1)", async () => {
    engine.mockResolvedValue({
      reply: "Please hold one moment.",
      nextState: "screening",
      riskUpdate: { score: 0, level: "low" },
      hold: true,
    });

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Pause", "Redirect"]);
    expect(xml).toContain("Please hold one moment.");
    expect(xml).toContain('length="10"');
    expect(xml).toContain(`${BASE_URL}/api/voice/hold-check?n=1`);
  });

  it("verified: dials the senior", async () => {
    engineReturns("verified");

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Dial", "Number"]);
    expect(xml).toContain('callerId="+15550001111"');
    expect(xml).toContain("+15550000000</Number>");
  });

  it("transferring: dials the senior", async () => {
    engineReturns("transferring");

    expect(parseTwiml(await (await turn()).text())).toEqual(["Dial", "Number"]);
  });

  it("scam_blocked: says the refusal line and hangs up without accusing", async () => {
    engineReturns("scam_blocked", "high", 90);

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Hangup"]);
    expect(xml).toContain("I'm not able to connect this call.");
    expect(xml.toLowerCase()).not.toContain("scam");
  });

  it("completed: says unable-to-connect and records a message", async () => {
    engineReturns("completed");

    expect(parseTwiml(await (await turn()).text())).toEqual(["Say", "Record"]);
  });
});

describe("POST /api/voice/turn: persistence", () => {
  it("stores the caller's speech as a transcript event", async () => {
    engineReturns("screening");

    await turn();

    expect(db.appendEvent).toHaveBeenCalledWith({
      call_id: callFixture().id,
      type: "transcript",
      payload: { type: "transcript", text: SPEECH.SpeechResult, speaker: "caller" },
    });
  });

  it("appends a state_change event only when the state changes", async () => {
    engineReturns("screening");
    await turn();
    expect(db.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "state_change" }));

    db.appendEvent.mockClear();
    engineReturns("scam_blocked", "high", 90);
    await turn();
    expect(db.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state_change",
        payload: { type: "state_change", from: "screening", to: "scam_blocked" },
      }),
    );
  });

  it("stores the engine's score as is: the engine owns the floor and the credits (R11)", async () => {
    // A lower score only comes from a safe-word or confirmed-callback credit,
    // which a second floor here would cancel.
    db.getCallBySid.mockResolvedValue(callFixture({ risk_score: 45 }));
    engineReturns("verified", "low", 5);

    await turn();

    expect(db.updateCall).toHaveBeenCalledWith(
      "CA_TEST_0001",
      expect.objectContaining({ risk_score: 5, risk_level: "low" }),
    );
  });
});

describe("POST /api/voice/turn: engine hangup, outcome and stateChangeExtra", () => {
  const ENDED = "2026-12-01T10:03:00.000Z";
  const EXIT = { started_at: "2026-12-01T10:00:00.000Z", ended_at: ENDED, seconds: 180, reason: "limit" };

  it("hangup: true gives Say then Hangup with the goodbye line", async () => {
    db.getCallBySid.mockResolvedValue(callFixture({ state: "time_wasted" }));
    engine.mockResolvedValue({
      reply: "Oh dear, I must go feed Marmalade. Goodbye!",
      nextState: "completed",
      riskUpdate: { score: 90, level: "high" },
      hangup: true,
      outcome: "time_wasted",
      stateChangeExtra: EXIT,
    });

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Hangup"]);
    expect(xml).toContain("Marmalade");
  });

  it("appendEvent receives the merged state_change payload and updateCall the outcome", async () => {
    db.getCallBySid.mockResolvedValue(callFixture({ state: "time_wasted" }));
    engine.mockResolvedValue({
      reply: "Goodbye!",
      nextState: "completed",
      riskUpdate: { score: 90, level: "high" },
      hangup: true,
      outcome: "time_wasted",
      stateChangeExtra: EXIT,
    });

    await turn();

    expect(db.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state_change",
        payload: { type: "state_change", from: "time_wasted", to: "completed", ...EXIT },
      }),
    );
    expect(db.updateCall).toHaveBeenCalledWith(
      "CA_TEST_0001",
      expect.objectContaining({ state: "completed", outcome: "time_wasted", ended_at: ENDED }),
    );
  });

  it("entry event carries started_at and the call keeps going", async () => {
    engine.mockResolvedValue({
      reply: "Oh my, hold on dear, I can't find my glasses.",
      nextState: "time_wasted",
      riskUpdate: { score: 90, level: "high" },
      stateChangeExtra: { started_at: "2026-12-01T10:00:00.000Z" },
    });

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(db.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { type: "state_change", from: "screening", to: "time_wasted", started_at: "2026-12-01T10:00:00.000Z" },
      }),
    );
    expect(db.updateCall).toHaveBeenCalledWith(
      "CA_TEST_0001",
      expect.not.objectContaining({ outcome: expect.anything(), ended_at: expect.anything() }),
    );
  });

  it("entering scam_blocked sets outcome blocked and ended_at", async () => {
    engineReturns("scam_blocked", "high", 90);

    await turn();

    expect(db.updateCall).toHaveBeenCalledWith(
      "CA_TEST_0001",
      expect.objectContaining({ outcome: "blocked", ended_at: expect.any(String) }),
    );
  });
});

describe("POST /api/voice/turn: silence", () => {
  const ev = (text: string, speaker = "caller") => ({
    type: "transcript",
    payload: { type: "transcript", text, speaker },
  });

  it("one empty turn: replies and keeps gathering", async () => {
    db.getCallEvents.mockResolvedValue([ev("Hello, who is this?"), ev("Please say your name.", "system"), ev("")]);
    engineReturns("screening", "low", 0, "Are you still there?");

    const xml = await (await turn({ ...SPEECH, SpeechResult: "" })).text();

    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(engine).toHaveBeenCalled();
    expect(db.updateCall).not.toHaveBeenCalledWith("CA_TEST_0001", { state: "completed", outcome: "dropped" });
  });

  it("two consecutive empty turns: says goodbye, records, and marks the call dropped", async () => {
    db.getCallEvents.mockResolvedValue([ev(""), ev("Are you still there?", "system"), ev("")]);

    const xml = await (await turn({ ...SPEECH, SpeechResult: "" })).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Record"]);
    expect(engine).not.toHaveBeenCalled();
    expect(db.updateCall).toHaveBeenCalledWith("CA_TEST_0001", { state: "completed", outcome: "dropped" });
  });

  it("two silent turns while the persona is active: goodbye, hang up, exit event once, outcome time_wasted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T10:00:07.000Z"));
    try {
      const entry = {
        type: "state_change",
        payload: { type: "state_change", from: "screening", to: "time_wasted", started_at: "2026-12-01T10:00:00.000Z" },
        created_at: "2026-12-01T10:00:00.000Z",
      };
      db.getCallBySid.mockResolvedValue(callFixture({ state: "time_wasted" }));
      db.getCallEvents.mockResolvedValue([entry, ev(""), ev("Could you speak up?", "system"), ev("")]);

      const xml = await (await turn({ ...SPEECH, SpeechResult: "" })).text();

      expect(parseTwiml(xml)).toEqual(["Say", "Hangup"]);
      expect(xml).toContain("Marmalade");
      expect(engine).not.toHaveBeenCalled();
      const exits = db.appendEvent.mock.calls.filter((c) => c[0].type === "state_change");
      expect(exits).toHaveLength(1);
      expect(exits[0]![0].payload).toEqual({
        type: "state_change",
        from: "time_wasted",
        to: "completed",
        started_at: "2026-12-01T10:00:00.000Z",
        ended_at: "2026-12-01T10:00:07.000Z",
        seconds: 7,
        reason: "caller_silent",
      });
      expect(db.updateCall).toHaveBeenCalledWith(
        "CA_TEST_0001",
        expect.objectContaining({ state: "completed", outcome: "time_wasted", ended_at: "2026-12-01T10:00:07.000Z" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty turn separated by speech does not count as consecutive", async () => {
    db.getCallEvents.mockResolvedValue([ev(""), ev("I am calling about the appointment"), ev("")]);
    engineReturns("screening");

    expect(parseTwiml(await (await turn({ ...SPEECH, SpeechResult: "" })).text())).toEqual(["Gather", "Say", "Redirect"]);
  });
  it("still stores the empty turn as a transcript event", async () => {
    await turn({ ...SPEECH, SpeechResult: "" });

    expect(db.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "transcript", payload: expect.objectContaining({ text: "" }) }),
    );
  });
});

describe("POST /api/voice/turn: safe word redaction", () => {
  const WORD = "pumpkin";
  const sys = (text: string) => ({
    type: "transcript",
    payload: { type: "transcript", text, speaker: "system" },
  });
  const caller = (text: string) => ({
    type: "transcript",
    payload: { type: "transcript", text, speaker: "caller" },
  });

  function serializedAppends(): string[] {
    return db.appendEvent.mock.calls.map((c) => JSON.stringify(c));
  }

  it.each([
    ["challenge", "What's the family word?"],
    ["retry", "Sorry, I didn't catch that. What's the family word?"],
  ])("during the %s line, no appendEvent payload contains the spoken word", async (_n, line) => {
    db.getCallEvents.mockResolvedValue([caller("Grandma it's me"), sys(line)]);
    engineReturns("screening", "low", 0, "Sorry, I didn't catch that. What's the family word?");

    const res = await turn({ ...SPEECH, SpeechResult: `It's ${WORD}!` });
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(db.appendEvent).toHaveBeenCalledWith({
      call_id: callFixture().id,
      type: "transcript",
      payload: { type: "transcript", text: "[safe word attempt]", speaker: "caller" },
    });
    for (const serialized of serializedAppends()) {
      expect(serialized.toLowerCase()).not.toContain(WORD);
    }
  });

  it("outside the challenge, speech is stored as usual", async () => {
    db.getCallEvents.mockResolvedValue([caller("Hi"), sys("Could you tell me more?")]);
    engineReturns("screening");

    await turn({ ...SPEECH, SpeechResult: `I like ${WORD} pie` });

    expect(serializedAppends().some((s) => s.includes(WORD))).toBe(true);
  });
});

describe("POST /api/voice/turn: failures", () => {
  it("unknown CallSid: Say + Record fallback", async () => {
    db.getCallBySid.mockResolvedValue(null);

    expect(parseTwiml(await (await turn()).text())).toEqual(["Say", "Record"]);
    expect(engine).not.toHaveBeenCalled();
  });

  it("engine error: Say + Record fallback, not a 500", async () => {
    engine.mockRejectedValue(new Error("boom"));

    const res = await turn();

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Say", "Record"]);
  });

  it("rejects an invalid signature with 403 when mocks are off", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");

    const res = await turn();

    expect(res.status).toBe(403);
    expect(db.getCallBySid).not.toHaveBeenCalled();
  });
});
