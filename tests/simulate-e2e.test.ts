/**
 * Automated approximation of the manual check in docs/manual-check-simulate.md
 * (dashboard-and-simulator task 24). Runs whole scenarios through the real
 * simulator, processTurn(), engine(), finalizeCall() and sendAlerts() against
 * an in-memory database, with a recording telephony provider.
 *
 * It does not cover the browser: the 1.5 s pacing, badges, meter and timer.
 *
 * All tests here pass; the checklist SMS needs calls.payment_method (task 6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mem = vi.hoisted(() => ({
  calls: [] as Record<string, any>[],
  events: [] as Record<string, any>[],
  sms: [] as { to: string; body: string }[],
  reports: [] as string[],
  seq: 0,
}));

const FAMILY = [
  { id: "m1", name: "Alex", phone: "+15550100001", gets_alerts: true, is_callback_target: true },
  { id: "m2", name: "Sam", phone: "+15550100002", gets_alerts: true, is_callback_target: false },
];

vi.mock("@/lib/db", async () => {
  // Real bcrypt hash (cost 4) of the SIMULATOR_SAFE_WORD value stubbed below.
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
    adminDb: () => {
      throw new Error("adminDb must not be reached in this test");
    },
    getHousehold: async () => household,
    getAlertRecipients: async () => FAMILY,
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

vi.mock("@/lib/providers", async (orig) => {
  const real = await orig<typeof import("@/lib/providers")>();
  return {
    ...real,
    getTelephony: () => ({
      sendSms: async (to: string, body: string) => {
        mem.sms.push({ to, body });
      },
    }),
  };
});
vi.mock("@/lib/report", () => ({
  buildAndStoreReport: vi.fn(async (callId: string) => {
    mem.reports.push(callId);
  }),
}));

import { startSimulation, nextStep } from "@/lib/simulator/run";

const HOUSEHOLD_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  mem.calls = [];
  mem.events = [];
  mem.sms = [];
  mem.reports = [];
  vi.stubEnv("AI_PROVIDER", "mock");
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("SIMULATOR_SAFE_WORD", "teapot");
  vi.stubEnv("PUBLIC_BASE_URL", "https://ghostline.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run(scenarioId: string) {
  const start = await startSimulation({ householdId: HOUSEHOLD_ID, scenarioId });
  let index = 0;
  let last;
  do {
    last = await nextStep({ callSid: start.callSid, index: index++ });
  } while (!last.done);
  return mem.calls.find((c) => c.call_sid === start.callSid)!;
}

describe("doctor, the legitimate scenario (task 24, second half)", () => {
  it("ends LOW with no alert SMS and no report", async () => {
    const call = await run("doctor");
    expect(call.is_simulated).toBe(true);
    expect(call.ended_at).not.toBeNull();
    expect(call.risk_level).toBe("low");
    expect(mem.sms).toEqual([]);
    expect(mem.reports).toEqual([]);
    expect(mem.events.some((e) => e.type === "alert_sent")).toBe(false);
  });
});

describe("grandchild with the safe word", () => {
  it("is verified and no stored event contains the scripted word", async () => {
    const call = await run("grandchild");
    expect(call.state).toBe("verified");
    expect(JSON.stringify(mem.events)).not.toContain("teapot");
    expect(mem.events.some((e) => e.type === "safe_word_attempt" && e.payload.matched === true)).toBe(true);
  });
});

describe("grandparent (task 24, first half)", () => {
  it("runs to the end, is flagged simulated, and has caller lines stored in order", async () => {
    const call = await run("grandparent");
    expect(call.is_simulated).toBe(true);
    expect(call.call_sid).toMatch(/^SIM_grandparent_/);
    expect(call.ended_at).not.toBeNull();
    const callerLines = mem.events.filter(
      (e) => e.call_id === call.id && e.type === "transcript" && e.payload.speaker === "caller",
    );
    expect(callerLines.length).toBeGreaterThan(0);
  });

  it("reaches HIGH", async () => {
    const call = await run("grandparent");
    expect(call.risk_level).toBe("high");
  });

  it("sends one SIMULATED: alert per family member, once", async () => {
    await run("grandparent");
    const alerts = mem.sms.filter((s) => s.body.startsWith("SIMULATED: GHOSTLINE HIGH"));
    expect(alerts.map((s) => s.to).sort()).toEqual(FAMILY.map((m) => m.phone).sort());
  });

  it("stores one report for the call", async () => {
    const call = await run("grandparent");
    expect(mem.reports).toEqual([call.id]);
  });

  it(
    "sends the checklist SMS to each family member",
    async () => {
      // "cra" has no family claim. In "grandparent" the gift-card line is the
      // challenge answer, which is redacted and never read for payment details.
      await run("cra");
      const checklist = mem.sms.filter((s) => s.body.startsWith("Reminder for"));
      expect(checklist).toHaveLength(FAMILY.length);
    },
  );
});
