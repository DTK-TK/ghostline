/**
 * Replays every fixture turn by turn through processTurn() and the real
 * engine() with the mock AI and an in-memory database (same approach as
 * tests/simulate.test.ts). Task 1b: scam calls must be able to reach HIGH.
 *
 * Set REPLAY_OUT=<file> to dump { id, level, state, alerts } for each fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";

const mem = vi.hoisted(() => ({
  calls: [] as Record<string, any>[],
  events: [] as Record<string, any>[],
  seq: 0,
}));

vi.mock("@/lib/db", async () => {
  // Real bcrypt hash (cost 4) of the safe word spoken by real-grandchild replays.
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

import { createCall, getCallBySid } from "@/lib/db";
import { processTurn } from "@/lib/turn";
import { sendAlerts } from "@/lib/alerts";
import scams from "./fixtures/scams.json";
import legitimate from "./fixtures/legitimate.json";

interface Fixture {
  id: string;
  category: string;
  caller: string[];
  expectedLevel: "low" | "medium" | "high";
  safeWordCorrect?: boolean;
  knownGap?: boolean;
  reason?: string;
}

const HOUSEHOLD_ID = "11111111-1111-4111-8111-111111111111";
const results: Array<{ id: string; level: string | null; state: string; alerts: number }> = [];

beforeEach(() => {
  mem.calls = [];
  mem.events = [];
  vi.mocked(sendAlerts).mockClear();
  vi.stubEnv("AI_PROVIDER", "mock");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function replay(f: Fixture) {
  const callSid = `CA_replay_${f.id}`;
  await createCall({
    household_id: HOUSEHOLD_ID,
    call_sid: callSid,
    from_number: "+15550100000",
    state: "screening",
  } as never);
  const states: string[] = [];
  // A real grandchild answers the challenge right after the family claim, so
  // the safe word follows the first line (a family claim never connects without it).
  const lines = f.safeWordCorrect ? [f.caller[0]!, "teapot", ...f.caller.slice(1)] : f.caller;
  for (const line of lines) {
    const r = await processTurn({ callSid, speech: line, source: "simulator" });
    if (r.kind !== "turn") throw new Error("call not found");
    states.push(r.nextState);
    if (r.alreadyEnded || ["scam_blocked", "completed", "verified", "transferring", "time_wasted"].includes(r.nextState)) break;
  }
  const call = (await getCallBySid(callSid))!;
  const out = {
    id: f.id,
    level: call.risk_level as string | null,
    state: call.state as string,
    alerts: vi.mocked(sendAlerts).mock.calls.length,
    states,
  };
  results.push({ id: out.id, level: out.level, state: out.state, alerts: out.alerts });
  return { call, ...out };
}

describe("scam fixtures replayed through engine()", () => {
  for (const f of scams as Fixture[]) {
    const body = async () => {
      const r = await replay(f);
      expect(r.level, `${f.id}: states ${r.states.join(">")}`).toBe(f.expectedLevel);
      expect(r.state).not.toBe("verified");
    };
    if (f.knownGap) it.fails(`${f.id} [knownGap: ${f.reason}]`, body);
    else it(`${f.id} reaches ${f.expectedLevel}`, body);
  }
});

describe("legitimate fixtures replayed through engine()", () => {
  for (const f of legitimate as Fixture[]) {
    it(`${f.id} is never HIGH`, async () => {
      const r = await replay(f);
      expect(r.level).not.toBe("high");
      expect(["scam_blocked", "time_wasted"]).not.toContain(r.state);
    });
  }

  it("real grandchild fixtures end verified and LOW, and never store the safe word", async () => {
    for (const f of (legitimate as Fixture[]).filter((x) => x.safeWordCorrect)) {
      mem.calls = [];
      mem.events = [];
      const r = await replay(f);
      expect(r.state, f.id).toBe("verified");
      expect(r.level, f.id).toBe("low");
      expect(JSON.stringify(mem.events)).not.toContain("teapot");
    }
  });

  it("the doctor's-office fixture ends in completed (message) with no alert", async () => {
    const f = (legitimate as Fixture[]).find((x) => x.id === "legit-doctor-1")!;
    // Pad to 3 caller turns so the message path is reached.
    const r = await replay({ ...f, caller: [...f.caller, ...Array(3).fill("Please call us back.")].slice(0, Math.max(3, f.caller.length)) });
    expect(r.state).toBe("completed");
    expect(r.level).toBe("low");
    expect(sendAlerts).not.toHaveBeenCalled();
  });
});

it("writes REPLAY_OUT when requested", () => {
  if (process.env.REPLAY_OUT) writeFileSync(process.env.REPLAY_OUT, JSON.stringify(results, null, 1));
  expect(true).toBe(true);
});
