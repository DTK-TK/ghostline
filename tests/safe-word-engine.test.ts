/**
 * Safe-word-and-callback task 7: engine challenge and attempts, run through
 * the real processTurn() and engine() with an in-memory database and a
 * recorded AI call. Real bcrypt hash at cost 4.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";

const mem = vi.hoisted(() => ({
  call: null as Record<string, any> | null,
  events: [] as Record<string, any>[],
  household: {} as Record<string, any>,
  targets: [] as Record<string, any>[],
  callbackCall: vi.fn(),
  gemini: vi.fn(),
  seq: 0,
}));

vi.mock("@/lib/db", () => ({
  getHousehold: async () => mem.household,
  getCallBySid: async () => (mem.call ? { ...mem.call } : null),
  updateCall: async (_sid: string, patch: Record<string, any>) => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) mem.call![k] = v;
    return { ...mem.call };
  },
  appendEvent: async (e: Record<string, any>) => {
    const row = { id: String(++mem.seq), created_at: new Date().toISOString(), ...e };
    mem.events.push(row);
    return row;
  },
  getCallEvents: async () => mem.events.slice(),
  getCallbackTargets: async () => mem.targets,
}));
vi.mock("@/lib/providers", () => ({
  getTelephony: () => ({ startCallbackCall: mem.callbackCall }),
}));
vi.mock("@/lib/alerts", () => ({ sendAlerts: vi.fn(async () => undefined) }));
vi.mock("@/lib/scoring/ai", async (orig) => {
  const real = await orig<typeof import("@/lib/scoring/ai")>();
  return { ...real, callGemini: (...a: unknown[]) => mem.gemini(...a) };
});

import { processTurn } from "@/lib/turn";

// Test-only word. Never printed or logged.
const WORD = "kettle";
const WRONG1 = "wrong-guess-one";
const WRONG2 = "wrong-guess-two";
const FAMILY_REPLY = {
  reply: "Thank you. Who are you calling for?",
  risk_score: 0,
  flags: [],
  claims_family: true,
  claimed_identity: "Emma",
  summary: "",
  requested_amount: null,
  payment_method: null,
};

function setup(timeWaster: boolean) {
  mem.events = [];
  mem.targets = [];
  mem.callbackCall.mockReset();
  mem.gemini.mockReset();
  mem.gemini.mockResolvedValue(FAMILY_REPLY);
  mem.household = {
    id: "hh",
    family_name: "Sun",
    senior_phone: "+15550000000",
    safe_word_hash: bcrypt.hashSync(WORD, 4),
    time_waster_enabled: timeWaster,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  mem.call = {
    id: "call-1",
    call_sid: "CA_sw",
    household_id: "hh",
    state: "screening",
    risk_score: 0,
    risk_level: "low",
    claimed_identity: null,
    summary: null,
  };
}

async function say(speech: string) {
  const r = await processTurn({ callSid: "CA_sw", speech, source: "simulator" });
  if (r.kind !== "turn") throw new Error("not found");
  mem.call!.state = r.nextState;
  return r;
}

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "mock");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("engine starts the callback on a family claim (safe-word-and-callback task 10)", () => {
  const TARGET = { id: "m1", name: "Alex", phone: "+16135550142", gets_alerts: true, is_callback_target: true };

  it("claim turn: places one callback, holds the caller, and the next turn is still the challenge", async () => {
    setup(false);
    mem.targets = [TARGET];
    const claim = await say("Hi Grandma, it's Emma");
    expect(claim.hold).toBe(true);
    expect(claim.reply).toBe("Please hold one moment.");
    expect(claim.nextState).toBe("screening");
    expect(mem.callbackCall).toHaveBeenCalledTimes(1);
    expect(mem.callbackCall).toHaveBeenCalledWith("+16135550142", "CA_sw", "Emma");
    expect(mem.events.filter((e) => e.type === "callback_started")).toHaveLength(1);

    // The caller speaks after the hold (dev phone): the challenge is asked, not a second callback.
    const next = await say("Hello? Are you there?");
    expect(next.hold).toBe(false);
    expect(next.reply).toBe("What's the family word?");
    expect(mem.callbackCall).toHaveBeenCalledTimes(1);
  });

  it("no target: the caller gets the challenge straight away", async () => {
    setup(false);
    const claim = await say("Hi Grandma, it's Emma");
    expect(claim.hold).toBe(false);
    expect(claim.reply).toBe("What's the family word?");
    expect(mem.callbackCall).not.toHaveBeenCalled();
  });

  it("simulated calls never place a callback", async () => {
    setup(false);
    mem.targets = [TARGET];
    mem.call!.is_simulated = true;
    const claim = await say("Hi Grandma, it's Emma");
    expect(claim.hold).toBe(false);
    expect(mem.callbackCall).not.toHaveBeenCalled();
    expect(mem.events.some((e) => e.type === "callback_started")).toBe(false);
  });
});

describe("engine safe word challenge", () => {
  it("claim turn asks the family word; correct word gives verified without calling the AI", async () => {
    setup(false);
    const claim = await say("Hi Grandma, it's Emma");
    expect(claim.reply).toBe("What's the family word?");
    expect(claim.nextState).toBe("screening");
    expect(mem.gemini).toHaveBeenCalledTimes(1);

    const ok = await say(WORD);
    expect(ok.nextState).toBe("verified");
    expect(mem.gemini).toHaveBeenCalledTimes(1);
    const attempt = mem.events.find((e) => e.type === "safe_word_attempt")!;
    expect(attempt.payload).toMatchObject({ matched: true, attempt: "[redacted]" });
    expect(JSON.stringify(mem.events)).not.toContain(WORD);
    expect(ok.reply).not.toContain(WORD);
  });

  it.each([
    [true, "time_wasted"],
    [false, "scam_blocked"],
  ])("two wrong words (time waster %s) give %s", async (tw, expected) => {
    setup(tw);
    await say("Hi Grandma, it's Emma");
    const first = await say(WRONG1);
    expect(first.nextState).toBe("screening");
    expect(first.reply).toBe("Sorry, I didn't catch that. What's the family word?");
    const second = await say(WRONG2);
    expect(second.nextState).toBe(expected);
    expect(second.riskLevel).toBe("high");
    expect(mem.gemini).toHaveBeenCalledTimes(1);

    const attempts = mem.events.filter((e) => e.type === "safe_word_attempt");
    expect(attempts.map((a) => a.payload.matched)).toEqual([false, false]);
    expect(attempts.every((a) => a.payload.attempt === "[redacted]")).toBe(true);
    const stored = JSON.stringify(mem.events);
    for (const w of [WRONG1, WRONG2]) expect(stored).not.toContain(w);
    expect(mem.events.filter((e) => e.type === "red_flag" && e.payload.flag === "safe_word_fail")).toHaveLength(1);
  });

  it("a wrong word then the right word still verifies", async () => {
    setup(false);
    await say("Hi Grandma, it's Emma");
    await say(WRONG1);
    const ok = await say(WORD);
    expect(ok.nextState).toBe("verified");
    expect(JSON.stringify(mem.events)).not.toContain(WORD);
  });

  it("stores the caller turn as a placeholder, not the spoken text", async () => {
    setup(false);
    await say("Hi Grandma, it's Emma");
    await say(WORD);
    const callerTexts = mem.events
      .filter((e) => e.type === "transcript" && e.payload.speaker === "caller")
      .map((e) => e.payload.text);
    expect(callerTexts).toEqual(["Hi Grandma, it's Emma", "[safe word attempt]"]);
  });
  describe("failed attempts are scanned in memory only", () => {
    const PITCH = "I need 3000 in gift cards right now";

    it("a wrong answer adds payment_method and urgency, sets the call fields, and is never stored", async () => {
      setup(false);
      await say("Hi Grandma, it's Emma");
      const r = await say(PITCH);
      const flags = mem.events.filter((e) => e.type === "red_flag").map((e) => e.payload.flag);
      expect(flags).toEqual(expect.arrayContaining(["payment_method", "urgency", "safe_word_fail"]));
      for (const id of ["payment_method", "urgency"]) {
        const ev = mem.events.find((e) => e.type === "red_flag" && e.payload.flag === id)!;
        expect(ev.payload.quote).toBe("[redacted]");
      }
      expect(mem.call!.payment_method).toBe("gift card");
      expect(mem.call!.requested_amount).toBe("3000");
      // 40 + 20 from the attempt, 50 for the failure, capped at 100.
      expect(r.riskScore).toBe(100);
      expect(r.riskLevel).toBe("high");
      expect(mem.gemini).toHaveBeenCalledTimes(1);
      const stored = JSON.stringify(mem.events) + JSON.stringify(mem.call) + r.reply;
      expect(stored).not.toContain("3000 in gift");
      expect(stored).not.toContain(PITCH);
      expect(stored).not.toContain("right now");
    });

    it("a correct answer is never scanned", async () => {
      setup(false);
      // A safe word that the rules and extractors WOULD flag if it were scanned.
      mem.household.safe_word_hash = bcrypt.hashSync("bitcoin", 4);
      await say("Hi Grandma, it's Emma");
      const r = await say("bitcoin");
      expect(r.nextState).toBe("verified");
      expect(mem.events.some((e) => e.type === "red_flag" && e.payload.flag === "payment_method")).toBe(false);
      expect(mem.call!.payment_method ?? null).toBeNull();
      expect(JSON.stringify(mem.events)).not.toContain("bitcoin");
    });
  });
});
