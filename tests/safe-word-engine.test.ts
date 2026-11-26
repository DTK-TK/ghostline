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
});
