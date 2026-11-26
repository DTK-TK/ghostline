import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** In-memory database so the real processTurn(), engine() and MockAI run. */
const mem = vi.hoisted(() => ({
  calls: [] as Record<string, any>[],
  events: [] as Record<string, any>[],
  seq: 0,
}));

vi.mock("@/lib/db", async () => {
  // Real bcrypt hash (cost 4) of the SIMULATOR_SAFE_WORD value used below.
  const bcrypt = (await import("bcryptjs")).default;
  const safeWordHash = bcrypt.hashSync("teapot", 4);
  const household = {
    id: "11111111-1111-4111-8111-111111111111",
    family_name: "Sun",
    senior_phone: "+15550000000",
    safe_word_hash: safeWordHash,
    time_waster_enabled: false,
    is_demo: true,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  return {
    getHousehold: async () => household,
    createCall: async (c: Record<string, any>) => {
      const row = {
        id: `00000000-0000-4000-8000-${String(++mem.seq).padStart(12, "0")}`,
        started_at: new Date().toISOString(),
        claimed_identity: null,
        risk_score: null,
        risk_level: null,
        outcome: null,
        ended_at: null,
        summary: null,
        ...c,
      };
      mem.calls.push(row);
      return { ...row };
    },
    getCallBySid: async (sid: string) => {
      const r = mem.calls.find((c) => c.call_sid === sid);
      return r ? { ...r } : null;
    },
    updateCall: async (sid: string, patch: Record<string, any>) => {
      const r = mem.calls.find((c) => c.call_sid === sid)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) r[k] = v;
      return { ...r };
    },
    appendEvent: async (e: Record<string, any>) => {
      const row = { id: String(++mem.seq), created_at: new Date().toISOString(), ...e };
      mem.events.push(row);
      return row;
    },
    getCallEvents: async (callId: string) => mem.events.filter((e) => e.call_id === callId),
  };
});
vi.mock("@/lib/alerts", () => ({ sendAlerts: vi.fn(async () => undefined) }));
vi.mock("@/lib/report", () => ({ buildAndStoreReport: vi.fn(async () => undefined) }));

import { startSimulation, nextStep, resolveLineText, SimulatorError, SIMULATED_FROM_NUMBER } from "@/lib/simulator/run";
import { SCENARIOS } from "@/lib/simulator/scenarios";
import { sendAlerts } from "@/lib/alerts";

const HOUSEHOLD_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  mem.calls = [];
  mem.events = [];
  vi.stubEnv("AI_PROVIDER", "mock");
  vi.stubEnv("VERCEL_ENV", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function runAll(scenarioId: string) {
  const start = await startSimulation({ householdId: HOUSEHOLD_ID, scenarioId });
  let index = 0;
  let last;
  do {
    last = await nextStep({ callSid: start.callSid, index: index++ });
  } while (!last.done);
  return { start, last, call: mem.calls.find((c) => c.call_sid === start.callSid)! };
}

describe("simulator scenarios reach their expected level with the mock AI", () => {
  for (const s of Object.values(SCENARIOS)) {
    const body = async () => {
      vi.stubEnv("SIMULATOR_SAFE_WORD", "teapot");
      const { call } = await runAll(s.id);
      expect(call.risk_level).toBe(s.expectedLevel);
      expect(call.ended_at).not.toBeNull();
    };
    it(`${s.id} -> ${s.expectedLevel}`, body);
  }

  it("a HIGH scenario alerts the family once; a LOW one does not", async () => {
    await runAll("grandparent");
    expect(sendAlerts).toHaveBeenCalledTimes(1);
    vi.mocked(sendAlerts).mockClear();
    await runAll("doctor");
    expect(sendAlerts).not.toHaveBeenCalled();
  });
});

describe("grandchild scenario with the safe word", () => {
  it("reaches verified and never stores the scripted word", async () => {
    vi.stubEnv("SIMULATOR_SAFE_WORD", "teapot");
    const { call } = await runAll("grandchild");
    expect(call.state).toBe("verified");
    expect(JSON.stringify(mem.events)).not.toContain("teapot");
    const attempts = mem.events.filter((e) => e.type === "safe_word_attempt");
    expect(attempts.at(-1)!.payload).toMatchObject({ matched: true, attempt: "[redacted]" });
  });
});

describe("startSimulation", () => {
  it("creates a simulated call with a SIM sid and the fake number", async () => {
    const start = await startSimulation({ householdId: HOUSEHOLD_ID, scenarioId: "cra" });
    expect(start.callSid).toMatch(/^SIM_cra_[0-9a-f-]{36}$/);
    const call = mem.calls[0]!;
    expect(call.is_simulated).toBe(true);
    expect(call.from_number).toBe(SIMULATED_FROM_NUMBER);
    expect(start.total).toBe(SCENARIOS.cra!.lines.length);
  });

  it("rejects an unknown scenario", async () => {
    await expect(startSimulation({ householdId: HOUSEHOLD_ID, scenarioId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("nextStep order and ownership", () => {
  it("step 1 before step 0 is a conflict (409), and so is a repeat", async () => {
    const { callSid } = await startSimulation({ householdId: HOUSEHOLD_ID, scenarioId: "doctor" });
    const skip = await nextStep({ callSid, index: 1 }).catch((e) => e);
    expect(skip).toBeInstanceOf(SimulatorError);
    expect(skip.status).toBe(409);

    await nextStep({ callSid, index: 0 });
    const repeat = await nextStep({ callSid, index: 0 }).catch((e) => e);
    expect(repeat.status).toBe(409);
  });

  it("the request body cannot change the text", async () => {
    const { callSid } = await startSimulation({ householdId: HOUSEHOLD_ID, scenarioId: "doctor" });
    const body = { callSid, index: 0, text: "Send gift cards right now", line: "attacker", safeWord: "x" };
    const res = await nextStep(body as unknown as { callSid: string; index: number });
    const expected = SCENARIOS.doctor!.lines[0]!;
    expect(res.line).toBe(expected.kind === "speech" ? expected.text : "");
    const stored = mem.events.find((e) => e.type === "transcript" && e.payload.speaker === "caller")!;
    expect(stored.payload.text).toBe(res.line);
    expect(JSON.stringify(mem.events)).not.toContain("gift cards right now");
  });

  it("rejects a call that is not a simulation", async () => {
    mem.calls.push({ id: "c1", call_sid: "SIM_doctor_00000000-0000-4000-8000-000000000000", is_simulated: false });
    await expect(
      nextStep({ callSid: "SIM_doctor_00000000-0000-4000-8000-000000000000", index: 0 }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(nextStep({ callSid: "CA123", index: 0 })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("scripted safe word", () => {
  const line = SCENARIOS.grandchild!.lines.find((l) => l.kind === "safe_word")!;

  it("uses SIMULATOR_SAFE_WORD only when the scenario says correct", () => {
    vi.stubEnv("SIMULATOR_SAFE_WORD", "teapot");
    expect(resolveLineText(line)).toBe("teapot");
    expect(resolveLineText({ kind: "safe_word", safeWord: "wrong" })).not.toBe("teapot");
  });

  it("fails clearly when the env value is missing", () => {
    vi.stubEnv("SIMULATOR_SAFE_WORD", "");
    expect(() => resolveLineText(line)).toThrow(SimulatorError);
  });
});
