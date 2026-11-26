/**
 * POST /api/voice/hold-check (safe-word-and-callback task 2).
 * The caller-side hold loop: at most 4 passes of 10 seconds.
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

import { POST } from "@/app/api/voice/hold-check/route";

let events: Record<string, any>[] = [];
let call: Record<string, any>;

function ev(type: string, payload: Record<string, any>) {
  return { id: String(events.length + 1), call_id: call.id, type, payload: { type, ...payload }, created_at: "2026-01-01T00:00:00.000Z" };
}

function holdCheck(n: string | number | null = 1) {
  const path = n === null ? "/api/voice/hold-check" : `/api/voice/hold-check?n=${n}`;
  return POST(twilioRequest(path, { CallSid: call.call_sid }));
}

const results = () => events.filter((e) => e.type === "callback_result").map((e) => e.payload.outcome);

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", BASE_URL);
  call = callFixture({ risk_score: 30, risk_level: "low" });
  events = [ev("callback_started", { target_phone: "***0142" }), ev("transcript", { text: "Please hold one moment.", speaker: "system" })];
  db.getCallBySid.mockImplementation(async () => ({ ...call }));
  db.getHousehold.mockResolvedValue(householdFixture());
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

describe("POST /api/voice/hold-check: pending", () => {
  it.each([1, 2, 3])("n=%i waits 10 seconds and redirects to n+1", async (n) => {
    const res = await holdCheck(n);
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(parseTwiml(xml)).toEqual(["Pause", "Redirect"]);
    expect(xml).toContain('length="10"');
    expect(xml).toContain(`${BASE_URL}/api/voice/hold-check?n=${n + 1}`);
    expect(results()).toEqual([]);
  });

  it("n=4 records no_answer, thanks the caller and asks the family word", async () => {
    const xml = await (await holdCheck(4)).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Gather", "Say", "Redirect"]);
    expect(xml).toContain("Thank you for waiting.");
    expect(xml).toContain("What's the family word?");
    expect(xml).toContain(`action="${BASE_URL}/api/voice/turn"`);
    expect(results()).toEqual(["no_answer"]);
    const lastSystem = [...events].reverse().find((e) => e.type === "transcript" && e.payload.speaker === "system");
    expect(lastSystem!.payload.text).toBe("What's the family word?");
    expect(call.risk_score).toBe(30);
  });

  it.each(["0", "7", "abc", ""])("a bad n (%j) is treated as 4, so the hold never runs on", async (bad) => {
    await holdCheck(bad);
    expect(results()).toEqual(["no_answer"]);
  });

  it("a missing n is treated as 4", async () => {
    await holdCheck(null);
    expect(results()).toEqual(["no_answer"]);
  });

  it("never loops more than 4 passes: n=1,2,3 wait, n=4 stops", async () => {
    const kinds: string[][] = [];
    for (const n of [1, 2, 3, 4]) kinds.push(parseTwiml(await (await holdCheck(n)).text()));
    expect(kinds.filter((k) => k[0] === "Pause")).toHaveLength(3);
    expect(kinds[3]).not.toContain("Pause");
  });
});

describe("POST /api/voice/hold-check: results", () => {
  it("denied with the time-waster off: blocks the caller", async () => {
    events.push(ev("callback_result", { outcome: "denied" }));
    call.state = "scam_blocked";
    call.risk_level = "high";

    const xml = await (await holdCheck(2)).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Hangup"]);
    expect(xml).toContain("I'm not able to connect this call.");
    expect(xml.toLowerCase()).not.toContain("scam");
  });

  it("denied with the time-waster on: the grandmother takes over", async () => {
    events.push(ev("callback_result", { outcome: "denied" }));
    call.state = "time_wasted";
    call.risk_level = "high";

    const xml = await (await holdCheck(1)).text();

    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(xml).toContain("can't find my glasses");
    const lastSystem = [...events].reverse().find((e) => e.type === "transcript" && e.payload.speaker === "system");
    expect(lastSystem!.payload.text).toContain("glasses");
  });

  it("confirmed: the safe word is still asked, and the result is not rewritten", async () => {
    events.push(ev("callback_result", { outcome: "confirmed" }));

    const xml = await (await holdCheck(1)).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Gather", "Say", "Redirect"]);
    expect(xml).toContain("What's the family word?");
    expect(results()).toEqual(["confirmed"]);
  });

  it("a result that lands at the last pass is honoured, not overwritten with no_answer", async () => {
    // The press arrives between the first read and the give-up write.
    let reads = 0;
    db.getCallEvents.mockImplementation(async () => {
      reads++;
      if (reads === 2) events.push(ev("callback_result", { outcome: "confirmed" }));
      return events.slice();
    });

    await holdCheck(4);

    expect(results()).toEqual(["confirmed"]);
  });

  it("does not store the challenge twice", async () => {
    events.push(ev("callback_result", { outcome: "confirmed" }));
    await holdCheck(1);
    await holdCheck(2);

    const challenges = events.filter((e) => e.type === "transcript" && e.payload.text === "What's the family word?");
    expect(challenges).toHaveLength(1);
  });

  it("an already ended call just hangs up", async () => {
    call.state = "completed";

    const xml = await (await holdCheck(1)).text();

    expect(parseTwiml(xml)).toEqual(["Hangup"]);
    expect(results()).toEqual([]);
  });
});

describe("POST /api/voice/hold-check: failures", () => {
  it("an unknown CallSid returns safe TwiML", async () => {
    db.getCallBySid.mockResolvedValue(null);

    const res = await holdCheck(1);

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Say", "Record"]);
  });

  it("a database error returns safe TwiML", async () => {
    db.getCallBySid.mockRejectedValue(new Error("db down"));

    const res = await holdCheck(1);

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Say", "Record"]);
  });

  it("rejects an invalid signature with 403 when mocks are off", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");

    const res = await holdCheck(1);

    expect(res.status).toBe(403);
    expect(db.getCallBySid).not.toHaveBeenCalled();
  });
});
