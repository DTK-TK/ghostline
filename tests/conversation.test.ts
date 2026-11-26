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

vi.mock("@/lib/alert-call", () => ({ alertCall: vi.fn(async () => undefined) }));

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

  it("a confirmed callback keeps its 40-point credit on later turns (R11)", async () => {
    const out = await run([
      { type: "callback_result", payload: { type: "callback_result", outcome: "confirmed" } },
    ]);
    expect(out.riskUpdate.score).toBe(5);
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
    const alerts = await import("@/lib/alert-call");
    vi.mocked(alerts.alertCall).mockClear();
    expect((await turn(1, "screening")).nextState).toBe("screening");
    expect((await turn(2, "screening")).nextState).toBe("screening");
    expect(alerts.alertCall).not.toHaveBeenCalled();
  });

  it("completes after the 3rd caller turn and sends exactly one alert", async () => {
    const alerts = await import("@/lib/alert-call");
    vi.mocked(alerts.alertCall).mockClear();
    const out = await turn(3, "screening");
    expect(out.riskUpdate.level).toBe("medium");
    expect(out.nextState).toBe("completed");
    expect(alerts.alertCall).toHaveBeenCalledTimes(1);

    // A later turn on an already completed call does not alert again.
    expect((await turn(4, "completed")).nextState).toBe("completed");
    expect(alerts.alertCall).toHaveBeenCalledTimes(1);
  });

  it("tells alertCall that a message was taken", async () => {
    const alerts = await import("@/lib/alert-call");
    vi.mocked(alerts.alertCall).mockClear();
    expect((await turn(3, "screening")).nextState).toBe("completed");
    expect(alerts.alertCall).toHaveBeenCalledWith(expect.any(String), { messageTaken: true });
  });
});

// ---------------------------------------------------------------------------
// Task 16: state transitions, dedup, fallback, monotonic floor, updateCall
// ---------------------------------------------------------------------------

describe("engine: transitions, dedup, fallback, floor, updateCall", () => {
  type State = "screening" | "verified" | "scam_blocked" | "time_wasted" | "completed" | "transferring";

  const aiTurn = (over: Record<string, unknown> = {}) => ({
    reply: "Thank you. Who are you calling for?",
    risk_score: 0,
    flags: [] as string[],
    claims_family: false,
    claimed_identity: null,
    summary: "",
    ...over,
  });

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

  async function setup(opts: {
    ai?: Record<string, unknown> | Error;
    events?: unknown[];
    timeWaster?: boolean;
    call?: Record<string, unknown>;
  }) {
    const db = await import("@/lib/db");
    vi.mocked(db.getCallEvents).mockImplementation((async () => opts.events ?? []) as any);
    vi.mocked(db.getHousehold).mockImplementation((async () => ({
      id: "hh-1",
      family_name: "Testerson",
      time_waster_enabled: opts.timeWaster ?? false,
    })) as any);
    vi.mocked(db.getCallBySid).mockImplementation((async () => ({
      id: "call-1",
      household_id: "hh-1",
      claimed_identity: null,
      summary: null,
      ...opts.call,
    })) as any);
    vi.mocked(db.appendEvent).mockClear();
    vi.mocked(db.updateCall).mockClear();

    const ai = await import("@/lib/scoring/ai");
    if (opts.ai instanceof Error) {
      vi.spyOn(ai, "callGemini").mockRejectedValue(opts.ai);
    } else if (opts.ai) {
      vi.spyOn(ai, "callGemini").mockResolvedValue(opts.ai as any);
    }
    const { engine } = await import("@/lib/conversation");
    return { db, ai, engine };
  }

  const run = (
    engine: (i: any) => Promise<any>,
    currentState: State = "screening",
    currentRiskScore = 0,
  ) =>
    engine({
      callSid: "CA_test",
      speechResult: "Hello, I am calling about your appointment",
      currentState,
      currentRiskScore,
    });

  const redFlagIds = (db: typeof import("@/lib/db")) =>
    vi
      .mocked(db.appendEvent)
      .mock.calls.map((c) => c[0] as any)
      .filter((e) => e.type === "red_flag")
      .map((e) => e.payload.flag);

  describe("state per band", () => {
    it("HIGH with time-waster off -> scam_blocked", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 85 }), timeWaster: false });
      const out = await run(engine);
      expect(out.riskUpdate.level).toBe("high");
      expect(out.nextState).toBe("scam_blocked");
    });

    it("HIGH with time-waster on -> time_wasted", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 85 }), timeWaster: true });
      const out = await run(engine);
      expect(out.riskUpdate.level).toBe("high");
      expect(out.nextState).toBe("time_wasted");
    });

    it("MEDIUM with fewer than 3 caller turns -> screening", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 50 }) });
      const out = await run(engine);
      expect(out.riskUpdate.level).toBe("medium");
      expect(out.nextState).toBe("screening");
    });

    // Changed in task 1b: this used to expect "verified" on the first LOW turn.
    it("LOW without a family claim, first turn -> screening, never verified", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 10, claims_family: false }) });
      const out = await run(engine);
      expect(out.riskUpdate.level).toBe("low");
      expect(out.nextState).toBe("screening");
    });

    it("LOW with a family claim -> screening with the challenge reply", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 10, claims_family: true }) });
      const out = await run(engine);
      expect(out.riskUpdate.level).toBe("low");
      expect(out.nextState).toBe("screening");
      expect(out.reply).toBe("What's the family word?");
    });
  });

  describe("task 1b: connect only after a matched safe word (R7)", () => {
    const callerTurns = (n: number) =>
      Array.from({ length: n }, () => ({
        type: "transcript",
        payload: { type: "transcript", speaker: "caller", text: "Hello there" },
      }));
    const matched = { type: "safe_word_attempt", payload: { type: "safe_word_attempt", matched: true } };

    it("\"Hi Grandma it's me\" as a first turn never connects", async () => {
      const { engine } = await setup({
        ai: aiTurn({ risk_score: 0, claims_family: true }),
        events: callerTurns(1),
      });
      const out = await engine({
        callSid: "CA_test",
        speechResult: "Hi Grandma it's me",
        currentState: "screening",
        currentRiskScore: 0,
      });
      expect(out.nextState).toBe("screening");
      expect(out.reply).toBe("What's the family word?");
    });

    it("a family claim with no safe word never connects, even after many turns", async () => {
      const { engine } = await setup({
        ai: aiTurn({ risk_score: 0, claims_family: true }),
        events: callerTurns(6),
      });
      const out = await run(engine);
      expect(out.nextState).toBe("screening");
    });

    it("a family claim connects after a matched safe word", async () => {
      const { engine } = await setup({
        ai: aiTurn({ risk_score: 0, claims_family: true }),
        events: [...callerTurns(2), matched],
      });
      expect((await run(engine)).nextState).toBe("verified");
    });

    it("a denied callback beats a matched safe word (HIGH path)", async () => {
      const { engine } = await setup({
        ai: aiTurn({ risk_score: 0, claims_family: true }),
        events: [
          ...callerTurns(2),
          matched,
          { type: "callback_result", payload: { type: "callback_result", outcome: "denied" } },
        ],
      });
      const out = await run(engine);
      expect(out.riskUpdate.level).toBe("high");
      expect(out.nextState).toBe("scam_blocked");
    });

    it("the turn after the challenge is a safe word attempt: a miss re-asks neutrally and stays in screening", async () => {
      const { engine } = await setup({
        ai: aiTurn({ risk_score: 0, claims_family: false }),
        events: [
          ...callerTurns(1),
          { type: "transcript", payload: { type: "transcript", speaker: "system", text: "What's the family word?" } },
        ],
      });
      const out = await run(engine);
      expect(out.nextState).toBe("screening");
      expect(out.reply).toBe("Sorry, I didn't catch that. What's the family word?");
    });

    it("LOW, no claim, 3 caller turns -> completed with no alert", async () => {
      const alerts = await import("@/lib/alert-call");
      vi.mocked(alerts.alertCall).mockClear();
      const { engine } = await setup({ ai: aiTurn({ risk_score: 0 }), events: callerTurns(3) });
      const out = await run(engine);
      expect(out.nextState).toBe("completed");
      expect(alerts.alertCall).not.toHaveBeenCalled();
    });

    it("LOW, no claim, 2 caller turns -> still screening", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 0 }), events: callerTurns(2) });
      expect((await run(engine)).nextState).toBe("screening");
    });

    it("HIGH on the first turn goes straight to the HIGH path", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 90 }), events: callerTurns(1) });
      expect((await run(engine)).nextState).toBe("scam_blocked");
    });
  });

  describe("terminal states", () => {
    it.each(["scam_blocked", "completed", "verified", "transferring"] as const)(
      "%s never transitions, even when the score is HIGH",
      async (state) => {
        const { engine } = await setup({ ai: aiTurn({ risk_score: 95 }) });
        const out = await run(engine, state);
        expect(out.nextState).toBe(state);
      },
    );

    it("a terminal state is kept when the score is LOW too", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 0 }) });
      expect((await run(engine, "scam_blocked")).nextState).toBe("scam_blocked");
    });
  });

  describe("red_flag dedup", () => {
    it("writes a new AI flag once", async () => {
      const { engine, db } = await setup({ ai: aiTurn({ risk_score: 30, flags: ["urgency", "urgency"] }) });
      await run(engine);
      expect(redFlagIds(db)).toEqual(["urgency"]);
    });

    it("does not rewrite a flag that already has a red_flag event", async () => {
      const { engine, db } = await setup({
        ai: aiTurn({ risk_score: 30, flags: ["urgency", "secrecy"] }),
        events: [{ type: "red_flag", payload: { type: "red_flag", flag: "urgency" } }],
      });
      await run(engine);
      expect(redFlagIds(db)).toEqual(["secrecy"]);
    });

    it("writes no red_flag events when every flag was already recorded", async () => {
      const { engine, db } = await setup({
        ai: aiTurn({ risk_score: 30, flags: ["urgency"] }),
        events: [{ type: "red_flag", payload: { type: "red_flag", flag: "urgency" } }],
      });
      await run(engine);
      expect(redFlagIds(db)).toHaveLength(0);
    });
  });

  describe("AI fallback", () => {
    it("GeminiUnavailableError -> rules-only scoring and scripted reply", async () => {
      const ai = await import("@/lib/scoring/ai");
      const { engine, db } = await setup({
        ai: new ai.GeminiUnavailableError("timeout"),
        events: [],
      });
      const out = await engine({
        callSid: "CA_test",
        speechResult: "This is an emergency, I need help right now",
        currentState: "screening",
        currentRiskScore: 0,
      });
      expect(out.riskUpdate).toEqual({ score: 45, level: "medium" });
      expect(out.reply).toBe(
        "I need a moment. Could you tell me your name and reason for calling?",
      );
      const details = vi
        .mocked(db.appendEvent)
        .mock.calls.map((c) => c[0] as any)
        .filter((e) => e.type === "red_flag")
        .map((e) => e.payload.detail);
      expect(details.length).toBeGreaterThan(0);
      expect(details.every((d) => d === "rules-only")).toBe(true);
      const quotes = vi
        .mocked(db.appendEvent)
        .mock.calls.map((c) => c[0] as any)
        .filter((e) => e.type === "red_flag")
        .map((e) => e.payload.quote);
      expect(quotes.every((q) => q === "This is an emergency, I need help right now")).toBe(true);
    });

    it("Gemini down + \"Grandma it's me, I need help\" -> the safe word challenge", async () => {
      const ai = await import("@/lib/scoring/ai");
      const { engine } = await setup({ ai: new ai.GeminiUnavailableError("down"), events: [] });
      const out = await engine({
        callSid: "CA_test",
        speechResult: "Grandma it's me, I need help",
        currentState: "screening",
        currentRiskScore: 0,
      });
      expect(out.reply).toBe("What's the family word?");
      expect(out.nextState).toBe("screening");
    });

    it("Gemini down + a pharmacy line about \"your grandson's prescription\" is not challenged", async () => {
      const ai = await import("@/lib/scoring/ai");
      const { engine } = await setup({ ai: new ai.GeminiUnavailableError("down"), events: [] });
      const out = await engine({
        callSid: "CA_test",
        speechResult: "I'm calling about your grandson's prescription",
        currentState: "screening",
        currentRiskScore: 0,
      });
      expect(out.reply).not.toBe("What's the family word?");
    });

    it("uses the HIGH scripted line when the prior score is already HIGH", async () => {
      const ai = await import("@/lib/scoring/ai");
      const { engine } = await setup({ ai: new ai.GeminiUnavailableError("bad json") });
      const out = await run(engine, "screening", 90);
      expect(out.riskUpdate.level).toBe("high");
      expect(out.reply).toBe("I'm not able to connect this call. Goodbye.");
    });

    it("rethrows errors that are not GeminiUnavailableError", async () => {
      const { engine } = await setup({ ai: new Error("boom") });
      await expect(run(engine)).rejects.toThrow("boom");
    });
  });

  describe("monotonic floor", () => {
    it("never lowers the score below currentRiskScore", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 10 }) });
      const out = await run(engine, "screening", 60);
      expect(out.riskUpdate).toEqual({ score: 60, level: "medium" });
    });

    it("a higher new score still wins over the floor", async () => {
      const { engine } = await setup({ ai: aiTurn({ risk_score: 80 }) });
      const out = await run(engine, "screening", 20);
      expect(out.riskUpdate).toEqual({ score: 80, level: "high" });
    });
  });

  describe("updateCall", () => {
    it("writes risk_score, risk_level, claimed_identity and summary from the AI", async () => {
      const { engine, db } = await setup({
        ai: aiTurn({
          risk_score: 55,
          claimed_identity: "Pat Example",
          summary: "Caller says they are from the bank.",
        }),
      });
      await run(engine);
      expect(db.updateCall).toHaveBeenCalledWith("CA_test", {
        risk_score: 55,
        risk_level: "medium",
        claimed_identity: "Pat Example",
        summary: "Caller says they are from the bank.",
      });
    });

    it("keeps the existing claimed_identity and summary when the AI is unavailable", async () => {
      const ai = await import("@/lib/scoring/ai");
      const { engine, db } = await setup({
        ai: new ai.GeminiUnavailableError("down"),
        call: { claimed_identity: "Sam Sample", summary: "Earlier summary." },
      });
      await run(engine);
      expect(db.updateCall).toHaveBeenCalledWith(
        "CA_test",
        expect.objectContaining({
          risk_score: 0,
          risk_level: "low",
          claimed_identity: "Sam Sample",
          summary: "Earlier summary.",
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// alerts-and-report task 6: persist amount and payment method
// ---------------------------------------------------------------------------

describe("engine: requested_amount and payment_method", () => {
  const aiTurn = (over: Record<string, unknown> = {}) => ({
    reply: "Thank you. Who are you calling for?",
    risk_score: 0,
    flags: [] as string[],
    claims_family: false,
    claimed_identity: null,
    requested_amount: null,
    payment_method: null,
    summary: "",
    ...over,
  });

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

  async function turn(opts: {
    ai: Record<string, unknown> | "down";
    speech: string;
    call?: Record<string, unknown>;
  }) {
    const db = await import("@/lib/db");
    vi.mocked(db.getCallEvents).mockImplementation((async () => []) as any);
    vi.mocked(db.getCallBySid).mockImplementation((async () => ({
      id: "call-1",
      household_id: "hh-1",
      claimed_identity: null,
      summary: null,
      requested_amount: null,
      payment_method: null,
      ...opts.call,
    })) as any);
    vi.mocked(db.updateCall).mockClear();
    const ai = await import("@/lib/scoring/ai");
    if (opts.ai === "down") {
      vi.spyOn(ai, "callGemini").mockRejectedValue(new ai.GeminiUnavailableError("down"));
    } else {
      vi.spyOn(ai, "callGemini").mockResolvedValue(opts.ai as any);
    }
    const { engine } = await import("@/lib/conversation");
    await engine({
      callSid: "CA_test",
      speechResult: opts.speech,
      currentState: "screening",
      currentRiskScore: 0,
    });
    return vi.mocked(db.updateCall).mock.calls[0]![1] as Record<string, unknown>;
  }

  it("\"send $500 in gift cards\" sets both from the AI result", async () => {
    const patch = await turn({
      ai: aiTurn({ requested_amount: "$500", payment_method: "gift cards" }),
      speech: "send $500 in gift cards",
    });
    expect(patch.requested_amount).toBe("$500");
    expect(patch.payment_method).toBe("gift cards");
  });

  it("a later turn without them keeps the stored values (no overwrite)", async () => {
    const patch = await turn({
      ai: aiTurn({ requested_amount: "  ", payment_method: null }),
      speech: "hello are you there",
      call: { requested_amount: "$500", payment_method: "gift cards" },
    });
    expect(patch.requested_amount).toBe("$500");
    expect(patch.payment_method).toBe("gift cards");
  });

  it("a later non-empty AI value replaces the stored one", async () => {
    const patch = await turn({
      ai: aiTurn({ requested_amount: "$900" }),
      speech: "make it $900",
      call: { requested_amount: "$500", payment_method: "gift cards" },
    });
    expect(patch.requested_amount).toBe("$900");
  });

  it("an AI failure still sets the payment method and amount by rules", async () => {
    const patch = await turn({ ai: "down", speech: "send $500 in gift cards" });
    expect(patch.payment_method).toBe("gift card");
    expect(patch.requested_amount).toBe("$500");
  });

  it("an AI failure with nothing to extract writes no empty values", async () => {
    const patch = await turn({ ai: "down", speech: "hello there" });
    expect(patch).not.toHaveProperty("payment_method");
    expect(patch).not.toHaveProperty("requested_amount");
  });
});
