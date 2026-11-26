import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const state = vi.hoisted(() => ({ events: [] as any[] }));

vi.mock("@/lib/db", () => ({
  getCallBySid: vi.fn(async () => ({
    id: "call-1",
    household_id: "hh-1",
    claimed_identity: null,
    summary: null,
    risk_score: 90,
    risk_level: "high",
    is_simulated: true,
  })),
  getHousehold: vi.fn(async () => ({ id: "hh-1", family_name: "Testerson", time_waster_enabled: true })),
  getCallEvents: vi.fn(async () => state.events),
  updateCall: vi.fn(async () => undefined),
  appendEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/alerts", () => ({ sendAlerts: vi.fn(async () => undefined) }));

const START = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("time limit properties", () => {
  it("limit: the call ends exactly when elapsed >= limit", async () => {
    const ai = await import("@/lib/scoring/ai");
    vi.spyOn(ai, "callGemini").mockResolvedValue({
      reply: "Pardon, dear?",
      risk_score: 90,
      flags: [],
      claims_family: false,
      claimed_identity: null,
      summary: "",
    } as any);
    const { engine } = await import("@/lib/conversation");

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 180 }),
        fc.integer({ min: 0, max: 200 }),
        async (limit, e) => {
          vi.stubEnv("TIME_WASTER_SECONDS", String(limit));
          state.events = [
            {
              type: "state_change",
              payload: { from: "screening", to: "time_wasted", started_at: START.toISOString() },
              created_at: START.toISOString(),
            },
            { type: "transcript", payload: { speaker: "caller", text: "pay now" }, created_at: START.toISOString() },
          ];
          vi.setSystemTime(new Date(START.getTime() + e * 1000));
          const out = await engine({
            callSid: "CA1",
            speechResult: "pay now",
            currentState: "time_wasted",
            currentRiskScore: 90,
          });
          const ended = out.hangup === true;
          expect(ended).toBe(e >= limit);
          if (ended) {
            expect(out.nextState).toBe("completed");
            expect(out.outcome).toBe("time_wasted");
          } else {
            expect(out.nextState).toBe("time_wasted");
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
