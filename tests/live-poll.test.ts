import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { NextRequest } from "next/server";
import { mergeEvents } from "@/lib/merge-events";
import { toPublicCall, toPublicEvent } from "@/lib/live-public";
import { getLivePayload, type LiveDeps } from "@/lib/live-poll";
import { isReconnecting, shouldKeepPolling } from "@/lib/poll-state";
import { proxy } from "@/proxy";
import type { CallEventRow, CallRow } from "@/lib/db";

const ev = (id: string, created_at: string) => ({ id, created_at });

describe("mergeEvents", () => {
  it("ignores a duplicate event id", () => {
    const a = ev("1", "2026-01-01T00:00:01.000Z");
    const out = mergeEvents([a], [{ ...a }, ev("2", "2026-01-01T00:00:02.000Z")]);
    expect(out.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("sorts out-of-order events by created_at", () => {
    const out = mergeEvents(
      [ev("b", "2026-01-01T00:00:02.000Z")],
      [ev("c", "2026-01-01T00:00:03.000Z"), ev("a", "2026-01-01T00:00:01.000Z")],
    );
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("property: unique ids, sorted, idempotent", () => {
    const arb = fc.array(
      fc.record({
        id: fc.integer({ min: 0, max: 20 }).map(String),
        created_at: fc.integer({ min: 0, max: 1e6 }).map((n) => new Date(1.7e12 + n).toISOString()),
      }),
    );
    fc.assert(
      fc.property(arb, arb, (x, y) => {
        const m = mergeEvents(x, y);
        expect(new Set(m.map((e) => e.id)).size).toBe(m.length);
        for (let i = 1; i < m.length; i++) {
          expect(Date.parse(m[i - 1]!.created_at)).toBeLessThanOrEqual(Date.parse(m[i]!.created_at));
        }
        expect(mergeEvents(m, y)).toEqual(m);
      }),
    );
  });
});

describe("polling rules", () => {
  it("reconnecting after two failed polls", () => {
    expect([0, 1, 2, 3].map(isReconnecting)).toEqual([false, false, true, true]);
  });
  it("stops after the ended state was fetched and confirmed", () => {
    expect([0, 1, 2].map(shouldKeepPolling)).toEqual([true, true, false]);
  });
});

describe("public projection", () => {
  it("drops safe word text and masks numbers", () => {
    const base = { id: "e", call_id: "c", created_at: "2026-01-01T00:00:00.000Z" };
    const sw = toPublicEvent({ ...base, type: "safe_word_attempt", payload: { matched: false, attempt: "rosebud" } });
    expect(JSON.stringify(sw)).not.toContain("rosebud");
    const cb = toPublicEvent({ ...base, type: "callback_started", payload: { target_phone: "+15551234567" } });
    expect(JSON.stringify(cb)).not.toContain("+15551234567");
    expect(cb.payload["target_phone"]).toContain("4567");
  });
});

const ID = "11111111-1111-4111-8111-111111111111";
const call: CallRow = {
  id: ID,
  household_id: "22222222-2222-4222-8222-222222222222",
  call_sid: "CA1",
  from_number: "+15559876543",
  claimed_identity: null,
  state: "screening",
  risk_score: 10,
  risk_level: "low",
  outcome: null,
  started_at: "2026-01-01T00:00:00.000Z",
  ended_at: null,
  summary: null,
  is_simulated: false,
};
const events: CallEventRow[] = [
  { id: "33333333-3333-4333-8333-333333333333", call_id: ID, type: "safe_word_attempt", payload: { matched: true, attempt: "secretword" }, created_at: "2026-01-01T00:00:01.000Z" },
];
const deps = (over: Partial<LiveDeps> = {}): LiveDeps => ({
  getCallById: async (id) => (id === ID ? call : null),
  getActiveCall: async () => call,
  getCallEvents: async () => events,
  getFraudReportId: async () => null,
  now: () => new Date("2026-01-01T00:01:00.000Z"),
  ...over,
});

describe("getLivePayload", () => {
  it("rejects a bad uuid with 400 and does not read the db", async () => {
    const r = await getLivePayload("not-a-uuid", deps({ getCallById: async () => { throw new Error("db hit"); } }));
    expect(r.status).toBe(400);
  });

  it("returns 404 for an unknown call", async () => {
    const r = await getLivePayload("44444444-4444-4444-8444-444444444444", deps());
    expect(r.status).toBe(404);
  });

  it("returns the call, sanitised events and report id", async () => {
    const r = await getLivePayload(ID, deps({ getFraudReportId: async () => "rep-1" }));
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("secretword");
    expect(text).not.toContain("5559876543");
    expect(text).not.toContain("safe_word_hash");
    expect((r.body as { reportId: string }).reportId).toBe("rep-1");
  });

  it("finds the active call when callId is omitted, null when none", async () => {
    const r = await getLivePayload(null, deps());
    expect((r.body as { call: { id: string } }).call.id).toBe(ID);
    const none = await getLivePayload(null, deps({ getActiveCall: async () => null }));
    expect(none.status).toBe(200);
    expect((none.body as { call: null }).call).toBeNull();
  });

  it("toPublicCall masks from_number", () => {
    expect(toPublicCall(call).from_number).toMatch(/6543$/);
  });
});

describe("/api/live behind the proxy", () => {
  const original = process.env.DASHBOARD_PASSCODE;
  afterEach(() => {
    if (original === undefined) delete process.env.DASHBOARD_PASSCODE;
    else process.env.DASHBOARD_PASSCODE = original;
  });

  it("gives 401 without the cookie", () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    expect(proxy(new NextRequest(`http://localhost:3000/api/live?callId=${ID}`)).status).toBe(401);
  });
});
