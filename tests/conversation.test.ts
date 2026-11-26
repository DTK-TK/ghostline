import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getCallBySid: vi.fn(async () => ({
    id: "call-1",
    household_id: "hh-1",
    claimed_identity: null,
    summary: null,
  })),
  getHousehold: vi.fn(async () => ({
    id: "hh-1",
    family_name: "Testerson",
    time_waster_enabled: false,
  })),
  getCallEvents: vi.fn(async () => []),
  updateCall: vi.fn(async () => undefined),
  appendEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/alerts", () => ({ sendAlerts: vi.fn(async () => undefined) }));

describe("engine: missing GEMINI_API_KEY", () => {
  const saved = { key: process.env.GEMINI_API_KEY, provider: process.env.AI_PROVIDER };

  beforeEach(() => {
    vi.resetModules(); // getAI() is a singleton
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER; // defaults to gemini
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.key;
    if (saved.provider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = saved.provider;
    vi.restoreAllMocks();
  });

  it("falls back to rules-only, returns a reply, logs without a key", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { engine } = await import("@/lib/conversation");
    const out = await engine({
      callSid: "CA_test",
      speechResult: "Hello, I am calling about your appointment",
      currentState: "screening",
      currentRiskScore: 0,
    });

    expect(out.reply.length).toBeGreaterThan(0);
    expect(out.riskUpdate.level).toBe("low");
    expect(errSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const logged = errSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Gemini unavailable");
    expect(logged).not.toMatch(/AIza[\w-]{10,}/);
    const key = saved.key;
    if (key) expect(logged).not.toContain(key);
  });
});

describe("engine: reply guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the scripted band line when Gemini returns a 40-word reply", async () => {
    const ai = await import("@/lib/scoring/ai");
    const longReply = Array(40).fill("word").join(" ");
    vi.spyOn(ai, "callGemini").mockResolvedValue({
      reply: longReply,
      risk_score: 0,
      flags: [],
      claims_family: false,
      claimed_identity: null,
      summary: "",
    } as any);

    const { engine } = await import("@/lib/conversation");
    const out = await engine({
      callSid: "CA_test",
      speechResult: "Hello, I am calling about your appointment",
      currentState: "screening",
      currentRiskScore: 0,
    });
    expect(out.riskUpdate.level).toBe("low");
    expect(out.reply).toBe("Thank you. Could you tell me more about why you're calling?");
  });
});

describe("engine: unknown AI flags", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes no red_flag event for a made_up flag", async () => {
    const db = await import("@/lib/db");
    vi.mocked(db.appendEvent).mockClear();
    vi.mocked(db.getCallEvents).mockImplementation((async () => []) as any);
    const ai = await import("@/lib/scoring/ai");
    vi.spyOn(ai, "callGemini").mockResolvedValue({
      reply: "Thank you. Who are you calling for?",
      risk_score: 0,
      flags: ["made_up"],
      claims_family: false,
      claimed_identity: null,
      summary: "",
    } as any);

    const { engine } = await import("@/lib/conversation");
    await engine({
      callSid: "CA_test",
      speechResult: "Hello, I am calling about your appointment",
      currentState: "screening",
      currentRiskScore: 0,
    });

    const redFlags = vi
      .mocked(db.appendEvent)
      .mock.calls.map((c) => c[0] as any)
      .filter((e) => e.type === "red_flag");
    expect(redFlags).toHaveLength(0);
  });
});

describe("engine: system reply persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the reply as a system transcript and includes it in the next turn's history", async () => {
    const db = await import("@/lib/db");
    const events: any[] = [];
    vi.mocked(db.appendEvent).mockClear();
    vi.mocked(db.appendEvent).mockImplementation((async (e: any) => {
      events.push(e);
    }) as any);
    vi.mocked(db.getCallEvents).mockImplementation((async () => events) as any);

    const ai = await import("@/lib/scoring/ai");
    const spy = vi.spyOn(ai, "callGemini");

    const { engine } = await import("@/lib/conversation");
    const first = await engine({
      callSid: "CA_test",
      speechResult: "Hello, I am calling about your appointment",
      currentState: "screening",
      currentRiskScore: 0,
    });

    const systemCalls = vi
      .mocked(db.appendEvent)
      .mock.calls.map((c) => c[0] as any)
      .filter((e) => e.type === "transcript" && e.payload.speaker === "system");
    expect(systemCalls).toHaveLength(1);
    expect(systemCalls[0].payload.text).toBe(first.reply);

    await engine({
      callSid: "CA_test",
      speechResult: "It is about Tuesday",
      currentState: "screening",
      currentRiskScore: 0,
    });
    const history = spy.mock.calls[1]![1] as Array<{ speaker: string; text: string }>;
    expect(history).toContainEqual({ speaker: "system", text: first.reply });
  });

  it("does not count system transcripts as caller utterances", async () => {
    const db = await import("@/lib/db");
    vi.mocked(db.getCallEvents).mockImplementation((async () => [
      { type: "transcript", payload: { type: "transcript", speaker: "system", text: "" } },
      { type: "transcript", payload: { type: "transcript", speaker: "caller", text: "" } },
      { type: "transcript", payload: { type: "transcript", speaker: "system", text: "gift card" } },
    ]) as any);
    const { countConsecutiveSilence } = await import("@/lib/silence");
    expect(await countConsecutiveSilence("call-1")).toBe(1);
  });
});

describe("engine: safe word and callback events", () => {
  // "emergency" (25) + "right now" (20) = 45 rules points, no AI score.
  const speech = "This is an emergency, I need help right now";
  const safeWord = {
    type: "safe_word_attempt",
    payload: { type: "safe_word_attempt", matched: true, attempt: "[redacted]" },
  };
  const denied = {
    type: "callback_result",
    payload: { type: "callback_result", outcome: "denied" },
  };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(events: unknown[]) {
    const db = await import("@/lib/db");
    vi.mocked(db.getCallEvents).mockImplementation((async () => events) as any);
    const { engine } = await import("@/lib/conversation");
    return engine({
      callSid: "CA_test",
      speechResult: speech,
      currentState: "screening",
      currentRiskScore: 0,
    });
  }

  it("no events keeps the old behaviour (45 points, medium)", async () => {
    const out = await run([]);
    expect(out.riskUpdate).toEqual({ score: 45, level: "medium" });
  });

  it("a matched safe word alone takes 40 off a 45-point transcript", async () => {
    const out = await run([safeWord]);
    expect(out.riskUpdate).toEqual({ score: 5, level: "low" });
  });

  it("a denied callback gives high, even with a matched safe word", async () => {
    const out = await run([safeWord, denied]);
    expect(out.riskUpdate.level).toBe("high");
    expect(out.riskUpdate.score).toBe(100);
  });

  it("a confirmed callback does not change the score", async () => {
    const out = await run([
      { type: "callback_result", payload: { type: "callback_result", outcome: "confirmed" } },
    ]);
    expect(out.riskUpdate.score).toBe(45);
  });

  const failed = {
    type: "safe_word_attempt",
    payload: { type: "safe_word_attempt", matched: false, attempt: "[redacted]" },
  };

  it("one failed safe word attempt adds 50 to the rules score", async () => {
    const out = await run([failed]);
    expect(out.riskUpdate).toEqual({ score: 95, level: "high" });
  });

  it("two failed attempts add 100 and the level is high", async () => {
    const out = await run([failed, failed]);
    expect(out.riskUpdate).toEqual({ score: 100, level: "high" });
  });

  it("two failed attempts on a clean transcript give exactly 100 (high)", async () => {
    const db = await import("@/lib/db");
    vi.mocked(db.getCallEvents).mockImplementation((async () => [failed, failed]) as any);
    const { engine } = await import("@/lib/conversation");
    const out = await engine({
      callSid: "CA_test",
      speechResult: "Hello, it is me",
      currentState: "screening",
      currentRiskScore: 0,
    });
    expect(out.riskUpdate).toEqual({ score: 100, level: "high" });
  });

  it("writes safe_word_fail once and does not duplicate an existing red_flag", async () => {
    const db = await import("@/lib/db");
    vi.mocked(db.appendEvent).mockClear();
    await run([failed, failed]);
    const flags = vi
      .mocked(db.appendEvent)
      .mock.calls.map((c) => c[0] as any)
      .filter((e) => e.type === "red_flag" && e.payload.flag === "safe_word_fail");
    expect(flags).toHaveLength(1);

    vi.mocked(db.appendEvent).mockClear();
    await run([
      failed,
      { type: "red_flag", payload: { type: "red_flag", flag: "safe_word_fail" } },
    ]);
    const again = vi
      .mocked(db.appendEvent)
      .mock.calls.map((c) => c[0] as any)
      .filter((e) => e.type === "red_flag" && e.payload.flag === "safe_word_fail");
    expect(again).toHaveLength(0);
  });
});

describe("engine: MEDIUM takes a message", () => {
  // "emergency" (25) + "right now" (20) = 45 points: MEDIUM, no AI score.
  const speech = "This is an emergency, I need help right now";
  const callerEvents = (n: number) =>
    Array.from({ length: n }, () => ({
      type: "transcript",
      payload: { type: "transcript", speaker: "caller", text: speech },
    }));

  beforeEach(() => {
    vi.resetModules();
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function turn(callerTurns: number, currentState: "screening" | "completed") {
    const db = await import("@/lib/db");
    vi.mocked(db.getCallEvents).mockImplementation((async () => callerEvents(callerTurns)) as any);
    const { engine } = await import("@/lib/conversation");
    return engine({ callSid: "CA_test", speechResult: speech, currentState, currentRiskScore: 0 });
  }

  it("keeps screening on caller turns 1 and 2, with no alert", async () => {
    const alerts = await import("@/lib/alerts");
    vi.mocked(alerts.sendAlerts).mockClear();
    expect((await turn(1, "screening")).nextState).toBe("screening");
    expect((await turn(2, "screening")).nextState).toBe("screening");
    expect(alerts.sendAlerts).not.toHaveBeenCalled();
  });

  it("completes after the 3rd caller turn and sends exactly one alert", async () => {
    const alerts = await import("@/lib/alerts");
    vi.mocked(alerts.sendAlerts).mockClear();
    const out = await turn(3, "screening");
    expect(out.riskUpdate.level).toBe("medium");
    expect(out.nextState).toBe("completed");
    expect(alerts.sendAlerts).toHaveBeenCalledTimes(1);

    // A later turn on an already completed call does not alert again.
    expect((await turn(4, "completed")).nextState).toBe("completed");
    expect(alerts.sendAlerts).toHaveBeenCalledTimes(1);
  });

  it("still completes the call when the alert fails", async () => {
    const alerts = await import("@/lib/alerts");
    vi.mocked(alerts.sendAlerts).mockRejectedValueOnce(new Error("sms down"));
    expect((await turn(3, "screening")).nextState).toBe("completed");
  });
});
