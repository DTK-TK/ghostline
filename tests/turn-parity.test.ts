import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { twilioRequest, householdFixture, callFixture } from "./helpers/voice";

/** In-memory call_events store so each run starts clean and records writes. */
const store = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>>, calls: [] as Array<Record<string, unknown>> }));
const db = vi.hoisted(() => ({
  getCallBySid: vi.fn(),
  getHousehold: vi.fn(),
  updateCall: vi.fn(),
  appendEvent: vi.fn(),
  getCallEvents: vi.fn(),
}));
const engine = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => db);
vi.mock("@/lib/conversation", () => ({ engine }));

import { POST as voiceTurn } from "@/app/api/voice/turn/route";
import { POST as devTurn } from "@/app/api/dev/phone/turn/route";

const SCRIPT = ["Hello, this is your grandson", "", "I need gift cards right now"];
const STATES = ["screening", "screening", "scam_blocked"] as const;

function setup() {
  store.events = [];
  store.calls = [];
  let call = callFixture();
  db.getCallBySid.mockImplementation(async () => ({ ...call }));
  db.getHousehold.mockResolvedValue(householdFixture());
  db.updateCall.mockImplementation(async (_sid: string, patch: Record<string, unknown>) => {
    store.calls.push(patch);
    call = { ...call, ...patch } as typeof call;
    return call;
  });
  db.appendEvent.mockImplementation(async (e: Record<string, unknown>) => {
    store.events.push(e);
    return e;
  });
  db.getCallEvents.mockImplementation(async () => store.events);
  let n = 0;
  engine.mockImplementation(async () => {
    const nextState = STATES[n++]!;
    return {
      reply: `reply ${n}`,
      nextState,
      riskUpdate: { score: nextState === "scam_blocked" ? 90 : 10, level: nextState === "scam_blocked" ? "high" : "low" },
    };
  });
}

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", "https://ghostline.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("processTurn parity: voice route and dev phone", () => {
  it("write identical events and call updates for the same script", async () => {
    setup();
    for (const speech of SCRIPT) {
      await voiceTurn(twilioRequest("/api/voice/turn", { CallSid: "CA_TEST_0001", SpeechResult: speech }));
    }
    const voice = { events: store.events, calls: store.calls };

    setup();
    for (const speech of SCRIPT) {
      await devTurn(
        new Request("https://ghostline.test/api/dev/phone/turn", {
          method: "POST",
          body: JSON.stringify({ callSid: "CA_TEST_0001", speechResult: speech }),
        }),
      );
    }
    const dev = { events: store.events, calls: store.calls };

    expect(voice.events.length).toBeGreaterThan(0);
    expect(dev.events).toEqual(voice.events);
    expect(dev.calls).toEqual(voice.calls);
    expect(voice.events).toContainEqual(
      expect.objectContaining({ payload: { type: "state_change", from: "screening", to: "scam_blocked" } }),
    );
  });
});
