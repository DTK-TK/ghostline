/**
 * At-most-once alert sending (alerts-and-report task 8a).
 * Validates: Requirements 6 (R6 Alert events)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mem = vi.hoisted(() => ({
  claims: new Set<string>(),
  sms: [] as { to: string; body: string }[],
  failFor: new Set<string>(),
  call: null as Record<string, unknown> | null,
  events: [] as Record<string, unknown>[],
  rows: [] as { id?: string; to_number: string; body: string; kind: string; created_at?: string }[],
  useMock: false,
}));

const FAMILY = [
  { id: "m1", name: "Alex", phone: "+15550100001", gets_alerts: true, is_callback_target: true },
  { id: "m2", name: "Sam", phone: "+15550100002", gets_alerts: true, is_callback_target: false },
];

vi.mock("@/lib/db", () => ({
  adminDb: () => ({
    from: () => ({
      insert: async (row: { to_number: string; body: string; kind: string }) => {
        mem.rows.push(row);
        return { error: null };
      },
      select: () => ({
        order: () => ({ limit: async () => ({ data: mem.rows, error: null }) }),
      }),
    }),
  }),
  getHousehold: async () => ({ id: "h1", family_name: "Sun" }),
  getAlertRecipients: async () => FAMILY,
  getCallbackTargets: async () => FAMILY.filter((m) => m.is_callback_target),
  getCallById: async () => mem.call,
  getCallBySid: async () => mem.call,
  getCallEvents: async () => mem.events,
  updateCall: async (_sid: string, patch: Record<string, unknown>) => {
    mem.call = { ...mem.call, ...patch };
  },
  claimAlertEvent: async (e: { call_id: string; payload: Record<string, string> }) => {
    const key = `${e.call_id}|${e.payload.alert_type}|${e.payload.recipient_id}`;
    if (mem.claims.has(key)) return false;
    mem.claims.add(key);
    return true;
  },
}));
vi.mock("@/lib/providers", () => ({
  getTelephony: () => mem.useMock ? new (globalThis as unknown as { __Mock: new () => never }).__Mock() : ({
    sendSms: async (to: string, body: string) => {
      if (mem.failFor.has(to)) throw new Error(`boom ${to} ${body}`);
      mem.sms.push({ to, body });
    },
  }),
}));

vi.mock("@/lib/report", () => ({ buildAndStoreReport: async () => undefined }));

import { sendAlerts, type AlertContext } from "@/lib/alerts";
import { alertCall } from "@/lib/alert-call";
import { handleCallStatus } from "@/lib/voice-status";
import { MockTelephony } from "@/lib/providers/telephony";
import { GET as inboxGET } from "@/app/api/dev/phone/inbox/route";
(globalThis as unknown as { __Mock: unknown }).__Mock = MockTelephony;

const context: AlertContext = {
  call: {
    id: "00000000-0000-4000-8000-000000000001",
    household_id: "00000000-0000-4000-8000-000000000002",
    call_sid: "CA1",
    from_number: "+15550100000",
    claimed_identity: "CRA",
    state: "completed",
    risk_score: 80,
    risk_level: "high",
    outcome: null,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    summary: null,
    is_simulated: false,
    requested_amount: null,
    payment_method: null,
  },
  level: "high",
  claimedIdentity: "CRA",
  requestedAmount: null,
  paymentMethod: null,
  safeWordResult: "failed",
  callbackResult: "denied",
};

beforeEach(() => {
  mem.claims.clear();
  mem.sms = [];
  mem.failFor.clear();
  mem.call = null;
  mem.events = [];
});

function pairs(): string[] {
  return mem.sms.map((s) => `${s.to}|${s.body.includes("GHOSTLINE STEPS") ? "checklist" : "risk"}`);
}

describe("task 4 case (a): repeated HIGH turns", () => {
  it("three calls with a payment method send 4 SMS, each pair once", async () => {
    const paid = { ...context, paymentMethod: "gift card" };
    await sendAlerts(paid);
    await sendAlerts(paid);
    await sendAlerts(paid);
    expect(mem.sms).toHaveLength(4);
    expect(new Set(pairs()).size).toBe(4);
  });

  it("three calls with paymentMethod null send 2 SMS", async () => {
    await sendAlerts(context);
    await sendAlerts(context);
    await sendAlerts(context);
    expect(mem.sms).toHaveLength(2);
    expect(new Set(pairs()).size).toBe(2);
  });
});

describe("task 4 case (b): concurrent calls", () => {
  it("Promise.all of two sendAlerts sends each pair once", async () => {
    const paid = { ...context, paymentMethod: "gift card" };
    await Promise.all([sendAlerts(paid), sendAlerts(paid)]);
    expect(mem.sms).toHaveLength(4);
    expect(new Set(pairs()).size).toBe(4);
  });
});

describe("task 4 case (c): alertCall and the status path", () => {
  it("alertCall three times, then the status route path, keeps the same total", async () => {
    mem.call = { ...context.call, payment_method: "gift card", state: "scam_blocked" };
    await alertCall(context.call.id);
    await alertCall(context.call.id);
    await alertCall(context.call.id);
    expect(mem.sms).toHaveLength(4);
    expect(await handleCallStatus("CA1", "completed")).toBe(true);
    expect(mem.sms).toHaveLength(4);
    expect(new Set(pairs()).size).toBe(4);
  });
});

describe("sendAlerts at-most-once", () => {
  it("sends once per recipient, and a second call sends nothing", async () => {
    await sendAlerts(context);
    expect(mem.sms.map((s) => s.to)).toEqual(["+15550100001", "+15550100002"]);
    await sendAlerts(context);
    expect(mem.sms).toHaveLength(2);
  });

  it("one recipient failing does not stop the next, and logs no full number", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mem.failFor.add("+15550100001");
    await sendAlerts(context);
    expect(mem.sms.map((s) => s.to)).toEqual(["+15550100002"]);
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).not.toContain("+15550100001");
    expect(logged).not.toContain("boom");
    err.mockRestore();
  });
});

describe("sendAlerts checklist", () => {
  it("paymentMethod null sends no checklist SMS", async () => {
    await sendAlerts(context);
    expect(mem.sms.filter((s) => s.body.includes("GHOSTLINE STEPS"))).toHaveLength(0);
  });

  it("with a payment method, each recipient gets one checklist naming the callback target, once", async () => {
    const paid = { ...context, paymentMethod: "gift card" };
    await sendAlerts(paid);
    await sendAlerts(paid);
    const steps = mem.sms.filter((s) => s.body.includes("GHOSTLINE STEPS"));
    expect(mem.sms).toHaveLength(4);
    expect(steps.map((s) => s.to)).toEqual(["+15550100001", "+15550100002"]);
    for (const s of steps) expect(s.body).toContain("Call Alex first.");
  });
});

// ---------------------------------------------------------------------------
// Dashboard-and-simulator task 21: MockTelephony in the loop, masked output.
// ---------------------------------------------------------------------------

describe("task 21: HIGH call reaches the mock store, once, with no full number", () => {
  it("writes one risk SMS and one checklist SMS per recipient, and a repeat adds none", async () => {
    mem.rows = [];
    mem.call = { ...context.call, payment_method: "gift card", state: "scam_blocked" };
    mem.useMock = true;
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    try {
      await alertCall(context.call.id);
      await alertCall(context.call.id);
      const sms = mem.rows.filter((r) => r.kind === "sms");
      expect(sms).toHaveLength(4);
      for (const m of FAMILY) {
        const mine = sms.filter((r) => r.to_number === m.phone);
        expect(mine.filter((r) => r.body.includes("GHOSTLINE STEPS"))).toHaveLength(1);
        expect(mine.filter((r) => !r.body.includes("GHOSTLINE STEPS"))).toHaveLength(1);
      }
      const logged = JSON.stringify(logs.flatMap((l) => l.mock.calls));
      expect(logged).toContain("MockTelephony");
      for (const m of FAMILY) expect(logged).not.toContain(m.phone);
      await new MockTelephony().startCallbackCall(FAMILY[0]!.phone, "CA1", "Sam +15559876543");
      const after = JSON.stringify(logs.flatMap((l) => l.mock.calls));
      expect(after).not.toContain("+15559876543");
      expect(after).not.toContain(FAMILY[0]!.phone);
    } finally {
      mem.useMock = false;
      logs.forEach((l) => l.mockRestore());
    }
  });
});

describe("task 21: inbox route masks numbers", () => {
  it("returns only masked numbers, also inside the body", async () => {
    vi.stubEnv("ENABLE_DEV_TOOLS", "true");
    vi.stubEnv("VERCEL_ENV", "");
    mem.rows = [
      { id: "1", to_number: "+14165550123", body: "Call +14165550123 now", kind: "sms", created_at: "2026-01-01T00:00:00Z" },
      { id: "2", to_number: "+14165550123", body: JSON.stringify({ originalCallSid: "CA1", claimedName: "Sam" }), kind: "callback_call", created_at: "2026-01-01T00:00:01Z" },
    ];
    const res = await inboxGET(new Request("http://localhost/api/dev/phone/inbox"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("14165550123");
    expect(JSON.parse(text).messages[0].to_number).toBe("***0123");
    vi.unstubAllEnvs();
  });

  it("is a 404 when the dev gate is closed", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ENABLE_DEV_TOOLS", "true");
    const res = await inboxGET(new Request("http://localhost/api/dev/phone/inbox"));
    expect(res.status).toBe(404);
    vi.unstubAllEnvs();
  });
});
