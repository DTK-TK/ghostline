/**
 * POST /api/voice/callback-result (safe-word-and-callback task 2).
 * Press 1 = denied, press 2 = confirmed, no answer or busy = no_answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BASE_URL, twilioRequest, parseTwiml, householdFixture, callFixture } from "./helpers/voice";

const db = vi.hoisted(() => ({
  getCallBySid: vi.fn(),
  getHousehold: vi.fn(),
  getCallEvents: vi.fn(),
  appendEvent: vi.fn(),
  updateCall: vi.fn(),
  getCallbackTargets: vi.fn(),
}));
vi.mock("@/lib/db", () => db);

const alerts = vi.hoisted(() => ({ sendAlerts: vi.fn() }));
const report = vi.hoisted(() => ({ buildAndStoreReport: vi.fn() }));
vi.mock("@/lib/alerts", () => alerts);
vi.mock("@/lib/report", () => report);

import { POST } from "@/app/api/voice/callback-result/route";

const ORIGINAL = "CA_TEST_0001";
let events: Record<string, any>[] = [];
let call: Record<string, any>;

function ev(type: string, payload: Record<string, any>) {
  return { id: String(events.length + 1), call_id: call.id, type, payload: { type, ...payload }, created_at: "2026-01-01T00:00:00.000Z" };
}

function post(params: Record<string, string>, query: Record<string, string> = {}) {
  const qs = new URLSearchParams({ originalCallSid: ORIGINAL, ...query }).toString();
  return POST(twilioRequest(`/api/voice/callback-result?${qs}`, { CallSid: "CA_CALLBACK_LEG", ...params }));
}

const results = () => events.filter((e) => e.type === "callback_result").map((e) => e.payload.outcome);

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", BASE_URL);
  call = callFixture({ risk_score: 30, risk_level: "low" });
  events = [ev("callback_started", { target_phone: "***0142" })];
  db.getCallBySid.mockImplementation(async () => ({ ...call }));
  db.getHousehold.mockResolvedValue({ ...householdFixture(), time_waster_enabled: false });
  db.getCallEvents.mockImplementation(async () => events.slice());
  db.appendEvent.mockImplementation(async (e: Record<string, any>) => {
    const row = ev(e.type, e.payload);
    events.push(row);
    return row;
  });
  db.updateCall.mockImplementation(async (_sid: string, patch: Record<string, any>) => {
    Object.assign(call, patch);
    return { ...call };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/voice/callback-result: digits", () => {
  it("Digits=1 writes denied, puts the call on the HIGH path and thanks the family member", async () => {
    const res = await post({ Digits: "1" });

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Say", "Hangup"]);
    expect(results()).toEqual(["denied"]);
    expect(call.risk_level).toBe("high");
    expect(call.risk_score).toBe(100);
    expect(call.state).toBe("scam_blocked");
  });

  it("Digits=2 writes confirmed and leaves the state alone", async () => {
    const res = await post({ Digits: "2" });

    expect(parseTwiml(await res.text())).toEqual(["Say", "Hangup"]);
    expect(results()).toEqual(["confirmed"]);
    expect(call.state).toBe("screening");
  });

  it("another digit repeats the prompt once, then counts as no_answer", async () => {
    const first = await (await post({ Digits: "7" }, { claimedName: "Sam" })).text();
    expect(parseTwiml(first)).toEqual(["Gather", "Say", "Say", "Hangup"]);
    expect(first).toContain("&amp;retry=1");
    expect(first).toContain("they are Sam is calling");
    expect(results()).toEqual([]);

    const second = await (await post({ Digits: "7" }, { claimedName: "Sam", retry: "1" })).text();
    expect(parseTwiml(second)).toEqual(["Say", "Hangup"]);
    expect(results()).toEqual(["no_answer"]);
  });
});

describe("POST /api/voice/callback-result: status callbacks", () => {
  it.each(["no-answer", "busy", "failed", "canceled", "completed"])("CallStatus=%s with no digit writes no_answer", async (status) => {
    const res = await post({ CallStatus: status });

    expect(res.status).toBe(200);
    expect(results()).toEqual(["no_answer"]);
    expect(call.risk_score).toBe(30);
    expect(call.state).toBe("screening");
  });

  it("ringing and in-progress write nothing", async () => {
    await post({ CallStatus: "ringing" });
    await post({ CallStatus: "in-progress" });
    expect(results()).toEqual([]);
  });

  it("a completed status after a press does not overwrite the result", async () => {
    await post({ Digits: "1" });
    await post({ CallStatus: "completed" });
    expect(results()).toEqual(["denied"]);
  });
});

describe("POST /api/voice/callback-result: first result wins", () => {
  it("a second request does not write a second result", async () => {
    await post({ Digits: "2" });
    await post({ Digits: "1" });
    await post({ Digits: "1" });

    expect(results()).toEqual(["confirmed"]);
    expect(call.state).toBe("screening");
    expect(call.risk_level).toBe("low");
  });

  it("a late press after no_answer is ignored", async () => {
    await post({ CallStatus: "no-answer" });
    await post({ Digits: "1" });

    expect(results()).toEqual(["no_answer"]);
    expect(call.state).toBe("screening");
  });

  it("writes nothing when no callback was started for the call", async () => {
    events = [];
    await post({ Digits: "1" });
    expect(results()).toEqual([]);
  });

  it("a missing originalCallSid writes nothing and returns empty TwiML", async () => {
    const res = await POST(twilioRequest("/api/voice/callback-result", { Digits: "1" }));

    expect(res.status).toBe(200);
    expect((await res.text()).replace(/<\?xml[^>]*\?>/, "")).toBe("<Response/>");
    expect(db.getCallBySid).not.toHaveBeenCalled();
  });
});

describe("POST /api/voice/callback-result: shared HIGH transition", () => {
  const stateChanges = () => events.filter((e) => e.type === "state_change").map((e) => e.payload);

  it("denied with time_waster_enabled writes the entry event with started_at", async () => {
    db.getHousehold.mockResolvedValue({ ...householdFixture(), time_waster_enabled: true });
    await post({ Digits: "1" });

    expect(call.state).toBe("time_wasted");
    expect(call.outcome ?? null).toBeNull();
    const changes = stateChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: "screening", to: "time_wasted" });
    expect(Number.isNaN(Date.parse(changes[0]!.started_at))).toBe(false);
  });

  it("denied with time_waster_enabled off writes scam_blocked with outcome blocked", async () => {
    await post({ Digits: "1" });

    expect(call.state).toBe("scam_blocked");
    expect(call.outcome).toBe("blocked");
    const changes = stateChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: "screening", to: "scam_blocked" });
    expect(changes[0]).not.toHaveProperty("started_at");
  });
});

describe("POST /api/voice/callback-result: family alert", () => {
  beforeEach(() => {
    alerts.sendAlerts.mockResolvedValue(undefined);
    report.buildAndStoreReport.mockResolvedValue({});
  });

  it("alerts once and builds the report on denied, even when the request repeats", async () => {
    await post({ Digits: "1" });
    await post({ Digits: "1" });
    await post({ CallStatus: "completed" });

    expect(alerts.sendAlerts).toHaveBeenCalledTimes(1);
    expect(alerts.sendAlerts.mock.calls[0]![0]).toMatchObject({ level: "high", callbackResult: "denied" });
    expect(report.buildAndStoreReport).toHaveBeenCalledTimes(1);
  });

  it("does not alert on confirmed", async () => {
    await post({ Digits: "2" });
    expect(alerts.sendAlerts).not.toHaveBeenCalled();
    expect(report.buildAndStoreReport).not.toHaveBeenCalled();
  });

  it("does not alert on no_answer", async () => {
    await post({ CallStatus: "no-answer" });
    expect(alerts.sendAlerts).not.toHaveBeenCalled();
  });

  it("an alert failure does not fail the webhook", async () => {
    alerts.sendAlerts.mockRejectedValue(new Error("sms down"));
    const res = await post({ Digits: "1" });
    expect(res.status).toBe(200);
    expect(results()).toEqual(["denied"]);
  });
});

describe("POST /api/voice/callback-result: failures", () => {
  it("a database error returns safe TwiML", async () => {
    db.getCallBySid.mockRejectedValue(new Error("db down"));

    const res = await post({ Digits: "1" });

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Hangup"]);
  });

  it("rejects an invalid signature with 403 when mocks are off", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");

    const res = await post({ Digits: "1" });

    expect(res.status).toBe(403);
    expect(db.getCallBySid).not.toHaveBeenCalled();
    expect(results()).toEqual([]);
  });
});
