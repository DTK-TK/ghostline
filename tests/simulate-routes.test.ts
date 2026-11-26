import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

const mem = vi.hoisted(() => ({
  demo: true,
  calls: [] as Record<string, any>[],
  events: [] as Record<string, any>[],
  starts: [] as string[],
  seq: 0,
}));

vi.mock("@/lib/db", () => ({
  getDemoHousehold: async () =>
    mem.demo ? { id: "11111111-1111-4111-8111-111111111111", family_name: "Sun", is_demo: true } : null,
  getSimulatedCallStarts: async () => [...mem.starts],
  createCall: async (c: Record<string, any>) => {
    const row = { id: `id-${++mem.seq}`, ended_at: null, ...c };
    mem.calls.push(row);
    mem.starts.push(new Date().toISOString());
    return { ...row };
  },
  getCallBySid: async (sid: string) => {
    const r = mem.calls.find((c) => c.call_sid === sid);
    return r ? { ...r } : null;
  },
  getCallEvents: async (callId: string) => mem.events.filter((e) => e.call_id === callId),
  appendEvent: async (e: Record<string, any>) => {
    mem.events.push(e);
    return e;
  },
}));
vi.mock("@/lib/turn", () => ({
  processTurn: vi.fn(async ({ callSid, speech }: { callSid: string; speech: string }) => {
    const call = mem.calls.find((c) => c.call_sid === callSid)!;
    mem.events.push({ call_id: call.id, type: "transcript", payload: { speaker: "caller", text: speech } });
    return { kind: "ok", reply: "ok", riskLevel: "low", riskScore: 0, nextState: "screening", call };
  }),
}));
vi.mock("@/lib/finalize-call", () => ({ finalizeCall: vi.fn(async () => undefined) }));

import { POST as start } from "@/app/api/simulate/route";
import { POST as step } from "@/app/api/simulate/step/route";
import { checkLimits, DAILY_CAP } from "@/lib/simulator/limits";

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  mem.demo = true;
  mem.calls = [];
  mem.events = [];
  mem.starts = [];
  vi.stubEnv("ENABLE_SIMULATOR", "true");
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/simulate", () => {
  it("404 without ENABLE_SIMULATOR=true", async () => {
    vi.stubEnv("ENABLE_SIMULATOR", "");
    expect((await start(post("/api/simulate", { scenarioId: "doctor" }))).status).toBe(404);
    expect((await step(post("/api/simulate/step", { callSid: "x", index: 0 }))).status).toBe(404);
  });

  it("403 when there is no demo household", async () => {
    mem.demo = false;
    expect((await start(post("/api/simulate", { scenarioId: "doctor" }))).status).toBe(403);
  });

  it("400 for an unknown scenario or a bad body", async () => {
    expect((await start(post("/api/simulate", { scenarioId: "nope" }))).status).toBe(400);
    expect((await start(post("/api/simulate", { scenarioId: "constructor" }))).status).toBe(400);
    expect((await start(post("/api/simulate", {}))).status).toBe(400);
    expect((await start(post("/api/simulate", { scenarioId: "doctor", text: "hi" }))).status).toBe(400);
  });

  it("starts a SIM call and reports willSendRealSms", async () => {
    const res = await start(post("/api/simulate", { scenarioId: "doctor" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.callSid).toMatch(/^SIM_doctor_[0-9a-f-]{36}$/);
    expect(body.willSendRealSms).toBe(false);

    vi.stubEnv("MOCK_TELEPHONY", "");
    mem.starts = [];
    const real = await (await start(post("/api/simulate", { scenarioId: "doctor" }))).json();
    expect(real.willSendRealSms).toBe(true);
  });

  it("429 for a second run within 30 s", async () => {
    expect((await start(post("/api/simulate", { scenarioId: "doctor" }))).status).toBe(200);
    const again = await start(post("/api/simulate", { scenarioId: "doctor" }));
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("429 once 50 runs happened today, even if the last was over 30 s ago", async () => {
    const t = Date.now() - 60_000;
    mem.starts = Array.from({ length: DAILY_CAP }, (_, i) => new Date(t - i * 1000).toISOString());
    const res = await start(post("/api/simulate", { scenarioId: "doctor" }));
    expect(res.status).toBe(429);
    expect((await res.json()).reason).toBe("daily_cap");
  });
});

describe("POST /api/simulate/step", () => {
  it("409 for a skipped or repeated step, 400 for a bad body", async () => {
    const { callSid } = await (await start(post("/api/simulate", { scenarioId: "doctor" }))).json();
    expect((await step(post("/api/simulate/step", { callSid, index: 1 }))).status).toBe(409);
    expect((await step(post("/api/simulate/step", { callSid, index: 0 }))).status).toBe(200);
    expect((await step(post("/api/simulate/step", { callSid, index: 0 }))).status).toBe(409);
    expect((await step(post("/api/simulate/step", { callSid, index: -1 }))).status).toBe(400);
    expect((await step(post("/api/simulate/step", { callSid, index: 0, text: "x" }))).status).toBe(400);
  });

  it("404 for an unknown call sid", async () => {
    const res = await step(post("/api/simulate/step", { callSid: "SIM_doctor_00000000-0000-4000-8000-000000000000", index: 0 }));
    expect(res.status).toBe(404);
  });
});

describe("checkLimits (property)", () => {
  it("allows only when the newest run is 30 s old and fewer than 50 ran in 24 h", () => {
    // **Validates: Requirements R10**
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 200_000_000 }), { maxLength: 120 }), (agesMs) => {
        const now = new Date("2026-06-01T12:00:00.000Z");
        const starts = agesMs.map((a) => new Date(now.getTime() - a).toISOString());
        const r = checkLimits(starts, now);
        const newestOk = agesMs.every((a) => a >= 30_000);
        const dayCount = agesMs.filter((a) => a < 86_400_000).length;
        expect(r.ok).toBe(newestOk && dayCount < DAILY_CAP);
      }),
    );
  });
});
