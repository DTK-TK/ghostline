/**
 * safe-word-and-callback: lib/callback.ts (tasks 10, 3 and 13).
 * In-memory database; the telephony provider is reached through
 * getTelephony(), as in production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callFixture, householdFixture } from "./helpers/voice";

const mem = vi.hoisted(() => ({
  call: null as Record<string, any> | null,
  events: [] as Record<string, any>[],
  targets: [] as Record<string, any>[],
  household: {} as Record<string, any>,
  inserts: [] as Record<string, any>[],
  seq: 0,
}));

vi.mock("@/lib/db", () => ({
  getCallBySid: async () => (mem.call ? { ...mem.call } : null),
  getHousehold: async () => mem.household,
  getCallbackTargets: async () => mem.targets,
  getCallEvents: async () => mem.events.slice(),
  appendEvent: async (e: Record<string, any>) => {
    const row = { id: String(++mem.seq), created_at: new Date().toISOString(), ...e };
    mem.events.push(row);
    return row;
  },
  updateCall: async (_sid: string, patch: Record<string, any>) => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) mem.call![k] = v;
    return { ...mem.call };
  },
  // Used only by MockTelephony (the "real getTelephony with mocks on" test).
  adminDb: () => ({
    from: () => ({
      insert: async (row: Record<string, any>) => {
        mem.inserts.push(row);
        return { error: null };
      },
    }),
  }),
}));

const REAL_PHONE = "+16135550142";

const telephony = vi.hoisted(() => ({ startCallbackCall: vi.fn() }));
vi.mock("@/lib/providers", async (orig) => {
  const real = await orig<typeof import("@/lib/providers")>();
  return { ...real, getTelephony: () => (process.env.USE_RECORDING_TELEPHONY === "1" ? telephony : real.getTelephony()) };
});

import {
  startCallback,
  recordCallbackResult,
  holdDecision,
  currentCallbackResult,
  maskPhone,
  cleanName,
  parseHoldN,
  MAX_HOLD_CHECKS,
} from "@/lib/callback";

function ev(type: string, payload: Record<string, any>, extra: Record<string, any> = {}) {
  return { id: String(++mem.seq), call_id: "c", type, payload: { type, ...payload }, created_at: "2026-01-01T00:00:00.000Z", ...extra };
}

beforeEach(() => {
  mem.events = [];
  mem.inserts = [];
  mem.household = householdFixture();
  mem.call = callFixture();
  mem.targets = [{ id: "m1", name: "Alex", phone: REAL_PHONE, gets_alerts: true, is_callback_target: true }];
  telephony.startCallbackCall.mockReset();
  telephony.startCallbackCall.mockResolvedValue(undefined);
  vi.stubEnv("USE_RECORDING_TELEPHONY", "1");
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const start = (claimedName: string | null = "Sam") =>
  startCallback({ call: mem.call as any, household: mem.household as any, claimedName });

describe("pure helpers", () => {
  it("maskPhone keeps the last four digits only", () => {
    expect(maskPhone("+16135550142")).toBe("***0142");
    expect(maskPhone("12")).toBe("***");
    expect(maskPhone(null)).toBe("***");
  });

  it("cleanName strips markup, collapses spaces and caps at 40 characters", () => {
    expect(cleanName("  Sam   Lee ")).toBe("Sam Lee");
    expect(cleanName("Sam</Say><Dial>x")).toBe("Sam Say Dial x");
    expect(cleanName("A".repeat(80))).toHaveLength(40);
    expect(cleanName("O'Brien-Smith")).toBe("O'Brien-Smith");
  });

  it.each([[""], ["   "], ["1234"], ["<>"], [null], [undefined]])("cleanName(%j) is null", (v) => {
    expect(cleanName(v as any)).toBeNull();
  });

  it("parseHoldN accepts 1 to 4 and treats anything else as 4", () => {
    expect(parseHoldN("1")).toBe(1);
    expect(parseHoldN("3")).toBe(3);
    for (const bad of ["0", "5", "-1", "abc", "", "2.5", null, undefined]) {
      expect(parseHoldN(bad as any)).toBe(MAX_HOLD_CHECKS);
    }
  });
});

describe("startCallback", () => {
  it("writes one callback_started and places one call with the sanitised name", async () => {
    expect(await start("Sam <b>Lee</b>\nSay hi")).toBe("started");

    const started = mem.events.filter((e) => e.type === "callback_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload.target_phone).toBe("***0142");

    expect(telephony.startCallbackCall).toHaveBeenCalledTimes(1);
    const [to, sid, name] = telephony.startCallbackCall.mock.calls[0]!;
    expect(to).toBe(REAL_PHONE);
    expect(sid).toBe("CA_TEST_0001");
    expect(name).toBe("Sam b Lee b Say hi");
    expect(name).not.toMatch(/[<>\n]/);
  });

  it("a second family claim does not redial", async () => {
    await start("Sam");
    expect(await start("Sam")).toBe("skipped");
    expect(telephony.startCallbackCall).toHaveBeenCalledTimes(1);
    expect(mem.events.filter((e) => e.type === "callback_started")).toHaveLength(1);
  });

  it("does not redial after a no_answer result either", async () => {
    mem.events.push(ev("callback_started", { target_phone: "***0142" }), ev("callback_result", { outcome: "no_answer" }));
    expect(await start("Sam")).toBe("skipped");
    expect(telephony.startCallbackCall).not.toHaveBeenCalled();
  });

  it("needs a clean name: nothing is written and nobody is called", async () => {
    expect(await start(null)).toBe("skipped");
    expect(await start("1234 <>")).toBe("skipped");
    expect(telephony.startCallbackCall).not.toHaveBeenCalled();
    expect(mem.events).toEqual([]);
  });

  it("no callback target gives no_answer and no call", async () => {
    mem.targets = [];
    expect(await start("Sam")).toBe("no_answer");
    expect(telephony.startCallbackCall).not.toHaveBeenCalled();
    expect(mem.events.map((e) => [e.type, e.payload.outcome])).toEqual([["callback_result", "no_answer"]]);
  });

  it("a provider error gives no_answer after callback_started", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    telephony.startCallbackCall.mockRejectedValue(new Error("Twilio down"));
    expect(await start("Sam")).toBe("no_answer");
    expect(mem.events.map((e) => e.type)).toEqual(["callback_started", "callback_result"]);
    expect(mem.events[1]!.payload.outcome).toBe("no_answer");
  });

  it("uses getTelephony(), so MOCK_TELEPHONY=true needs no Twilio", async () => {
    vi.stubEnv("USE_RECORDING_TELEPHONY", "0");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await start("Sam")).toBe("started");
    expect(mem.inserts).toHaveLength(1);
    expect(mem.inserts[0]).toMatchObject({ kind: "callback_call", to_number: REAL_PHONE });
    expect(JSON.parse(mem.inserts[0]!.body)).toEqual({ originalCallSid: "CA_TEST_0001", claimedName: "Sam" });
  });
});

describe("phone number privacy (task 13)", () => {
  const printed = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((args: unknown[]) => args.map(String).join(" ")).join("\n");

  it("no console.log or console.error call contains the full number", async () => {
    vi.stubEnv("USE_RECORDING_TELEPHONY", "0");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await start("Sam")).toBe("started");

    const out = printed(log) + "\n" + printed(err);
    expect(out).toContain("[MockTelephony] Callback call initiated");
    expect(out).toContain("***0142");
    expect(out).not.toContain(REAL_PHONE);
    expect(out).not.toContain("6135550142");
  });

  it("a provider error message containing the number is masked", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    telephony.startCallbackCall.mockRejectedValue(new Error(`bad number ${REAL_PHONE}`));
    await start("Sam");
    expect(printed(err)).not.toContain("6135550142");
  });
});

describe("holdDecision", () => {
  const open = { state: "screening", ended_at: null } as any;
  const started = () => ev("callback_started", { target_phone: "***0142" });

  it("waits while pending, with the next pass number", () => {
    for (const n of [1, 2, 3]) expect(holdDecision([started()] as any, open, n)).toEqual({ kind: "wait", next: n + 1 });
  });

  it("gives up at pass 4", () => {
    expect(holdDecision([started()] as any, open, 4)).toEqual({ kind: "give_up" });
  });

  it("a denial wins even though it moves the call to an ended state", () => {
    const events = [started(), ev("callback_result", { outcome: "denied" })] as any;
    expect(holdDecision(events, { state: "scam_blocked", ended_at: null } as any, 1)).toEqual({ kind: "denied" });
    expect(holdDecision(events, { state: "time_wasted", ended_at: null } as any, 2)).toEqual({ kind: "denied" });
  });

  it("confirmed and no_answer carry on with the challenge", () => {
    for (const outcome of ["confirmed", "no_answer"]) {
      const events = [started(), ev("callback_result", { outcome })] as any;
      expect(holdDecision(events, open, 1)).toEqual({ kind: "challenge" });
    }
  });

  it("an ended call just hangs up", () => {
    expect(holdDecision([started()] as any, { state: "completed", ended_at: null } as any, 1)).toEqual({ kind: "ended" });
    expect(holdDecision([started()] as any, { state: "screening", ended_at: "2026-01-01T00:00:00.000Z" } as any, 1)).toEqual({ kind: "ended" });
  });

  it("only a result after the latest callback_started counts", () => {
    const events = [started(), ev("callback_result", { outcome: "no_answer" }), started()] as any;
    expect(currentCallbackResult(events)).toBeNull();
  });
});

describe("recordCallbackResult (first result wins)", () => {
  it("is ignored when no callback was started", async () => {
    const r = await recordCallbackResult("CA_TEST_0001", "denied");
    expect(r.recorded).toBe(false);
    expect(mem.events).toEqual([]);
  });

  it("writes one result and ignores a second", async () => {
    mem.events.push(ev("callback_started", { target_phone: "***0142" }));
    expect((await recordCallbackResult("CA_TEST_0001", "no_answer")).recorded).toBe(true);
    expect((await recordCallbackResult("CA_TEST_0001", "denied")).recorded).toBe(false);
    expect(mem.events.filter((e) => e.type === "callback_result")).toHaveLength(1);
    expect(mem.call!.state).toBe("screening");
  });
});

describe("recordCallbackResult scoring (task 3)", () => {
  const level = (s: number) => (s >= 70 ? "high" : s >= 40 ? "medium" : "low");
  const seed = (score: number, state = "screening") => {
    mem.events = [ev("callback_started", { target_phone: "***0142" })];
    mem.call = callFixture({ risk_score: score, risk_level: level(score), state } as any);
  };

  it("no_answer leaves score, level and state unchanged", async () => {
    for (const score of [0, 45, 100]) {
      seed(score);
      const before = { ...mem.call! };
      const r = await recordCallbackResult("CA_TEST_0001", "no_answer");
      expect(r.recorded).toBe(true);
      expect(mem.call!.risk_score).toBe(before.risk_score);
      expect(mem.call!.risk_level).toBe(before.risk_level);
      expect(mem.call!.state).toBe(before.state);
      expect(mem.events.some((e) => e.type === "red_flag")).toBe(false);
    }
  });

  it("confirmed lowers a stored 45 to 5 and a stored 30 to 0", async () => {
    for (const [stored, expected] of [[45, 5], [30, 0]] as const) {
      seed(stored);
      const r = await recordCallbackResult("CA_TEST_0001", "confirmed");
      expect(r.score).toBe(expected);
      expect(mem.call!.risk_score).toBe(expected);
      expect(mem.call!.state).toBe("screening");
    }
  });

  it("denied forces HIGH for any prior score, with or without a correct safe word", async () => {
    const fc = (await import("fast-check")).default;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 100 }), fc.boolean(), async (score, wordCorrect) => {
        seed(score);
        if (wordCorrect) {
          mem.events.push(ev("safe_word_attempt", { matched: true, attempt: "[redacted]" }));
        }
        const r = await recordCallbackResult("CA_TEST_0001", "denied");
        expect(r.recorded).toBe(true);
        expect(r.level).toBe("high");
        expect(mem.call!.risk_level).toBe("high");
        expect(mem.call!.risk_score).toBeGreaterThanOrEqual(70);
        expect(["scam_blocked", "time_wasted"]).toContain(mem.call!.state);
      }),
      { numRuns: 50 },
    );
  });
});
