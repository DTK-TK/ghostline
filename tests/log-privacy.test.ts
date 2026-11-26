/**
 * Privacy of logs (alerts-and-report task 15, R13).
 * sendAlerts, alertCall, MockTelephony and the report code must not write a
 * full phone number or an SMS body to the console.
 * Validates: Requirements 13 (R13 Privacy)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

const mem = vi.hoisted(() => ({
  sms: [] as { to: string; body: string }[],
  failFor: new Set<string>(),
  inserts: [] as Record<string, unknown>[],
  call: null as Record<string, unknown> | null,
  throwOnCall: false,
}));

const NUMBER_A = "+14165550123";
const NUMBER_B = "+16045550199";
const CALLER = "+12125550147";
const FAMILY = [
  { id: "m1", name: "Alex", phone: NUMBER_A, gets_alerts: true, is_callback_target: true },
  { id: "m2", name: "Sam", phone: NUMBER_B, gets_alerts: true, is_callback_target: false },
];

vi.mock("@/lib/db", () => ({
  getHousehold: async () => ({ id: "h1", family_name: "Sun" }),
  getAlertRecipients: async () => FAMILY,
  getCallbackTargets: async () => FAMILY.filter((m) => m.is_callback_target),
  getCallById: async () => {
    if (mem.throwOnCall) throw new Error(`db down for ${CALLER} ${NUMBER_A}`);
    return mem.call;
  },
  getCallEvents: async () => [],
  claimAlertEvent: async () => true,
  getFraudReport: async () => null,
  createFraudReport: async (r: { call_id: string; report: unknown }) => ({
    id: "r1",
    call_id: r.call_id,
    report: r.report,
  }),
  CallSchema: { parse: (x: unknown) => x },
  adminDb: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        mem.inserts.push({ table, ...row });
        return { error: null };
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: mem.call, error: null }) }),
      }),
    }),
  }),
}));

vi.mock("@/lib/providers", async () => {
  const { MockTelephony } = await import("@/lib/providers/telephony");
  const real = new MockTelephony();
  return {
    getTelephony: () => ({
      sendSms: async (to: string, body: string) => {
        if (mem.failFor.has(to)) throw new Error(`failed ${to} ${body}`);
        mem.sms.push({ to, body });
        await real.sendSms(to, body);
      },
    }),
  };
});

import { sendAlerts, type AlertContext } from "@/lib/alerts";
import { alertCall } from "@/lib/alert-call";
import { MockTelephony } from "@/lib/providers/telephony";
import { buildAndStoreReport } from "@/lib/report";

const call = {
  id: "00000000-0000-4000-8000-000000000001",
  household_id: "00000000-0000-4000-8000-000000000002",
  call_sid: "CA1",
  from_number: CALLER,
  claimed_identity: "CRA",
  state: "completed",
  risk_score: 80,
  risk_level: "high",
  outcome: null,
  started_at: "2026-01-01T00:00:00.000Z",
  ended_at: null,
  summary: null,
  is_simulated: false,
  requested_amount: "$500",
  payment_method: "gift card",
};

const context: AlertContext = {
  call: call as AlertContext["call"],
  level: "high",
  claimedIdentity: "CRA",
  requestedAmount: "$500",
  paymentMethod: "gift card",
  safeWordResult: "failed",
  callbackResult: "denied",
};

const spies: ReturnType<typeof vi.spyOn>[] = [];

function watchConsole() {
  for (const m of ["log", "error", "warn", "info", "debug"] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  }
}

function logged(): string {
  return spies.map((s) => JSON.stringify(s.mock.calls)).join("\n");
}

function expectClean(bodies: string[] = []) {
  const out = logged();
  for (const n of [NUMBER_A, NUMBER_B, CALLER]) {
    expect(out).not.toContain(n);
    expect(out).not.toContain(n.slice(1));
    expect(out).not.toContain(n.slice(-7));
  }
  for (const b of bodies) {
    expect(b.length).toBeGreaterThan(20);
    expect(out).not.toContain(b);
    expect(out).not.toContain(b.slice(0, 20));
  }
}

beforeEach(() => {
  mem.sms = [];
  mem.failFor.clear();
  mem.inserts = [];
  mem.call = { ...call };
  mem.throwOnCall = false;
  watchConsole();
});

afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies.length = 0;
});

describe("log privacy", () => {
  it("sendAlerts logs no full number and no SMS body on success", async () => {
    await sendAlerts(context);
    expect(mem.sms).toHaveLength(4);
    expectClean(mem.sms.map((s) => s.body));
  });

  it("sendAlerts logs no full number and no SMS body when a send fails", async () => {
    mem.failFor.add(NUMBER_A);
    await sendAlerts(context);
    expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true);
    expectClean(mem.sms.map((s) => s.body));
  });

  it("alertCall logs nothing sensitive when sending and when it fails", async () => {
    await alertCall(call.id);
    mem.throwOnCall = true;
    await alertCall(call.id);
    expectClean(mem.sms.map((s) => s.body));
  });

  it("MockTelephony logs no full number and no body for every method", async () => {
    const t = new MockTelephony();
    const body = "GHOSTLINE HIGH: secret body text that must never be logged";
    await t.sendSms(NUMBER_A, body);
    await t.startCallbackCall(NUMBER_B, "CA9", "Jason");
    await t.connectCall("CA9", NUMBER_A);
    await t.endCall("CA9");
    expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true);
    expectClean([body]);
  });

  it("MockTelephony never logs a body or a full number for any input", async () => {
    const t = new MockTelephony();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2000000000, max: 9999999999 }),
        fc.string({ minLength: 25, maxLength: 120 }).filter((s) => s.trim().length >= 25),
        async (digits, body) => {
          for (const s of spies) s.mockClear();
          const phone = `+1${digits}`;
          await t.sendSms(phone, body);
          await t.connectCall("CA1", phone);
          const out = logged();
          expect(out).not.toContain(phone);
          expect(out).not.toContain(String(digits));
          expect(out).not.toContain(JSON.stringify(body).slice(1, -1));
        },
      ),
      { numRuns: 50 },
    );
  });

  it("the report code logs nothing, including the caller number", async () => {
    const row = await buildAndStoreReport(call.id);
    expect(JSON.stringify(row.report)).toContain(CALLER);
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
    expectClean();
  });
});
