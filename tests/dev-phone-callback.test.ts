import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { processTurn, getCallEvents } = vi.hoisted(() => ({
  processTurn: vi.fn(),
  getCallEvents: vi.fn(),
}));

vi.mock("@/lib/turn", () => ({ processTurn }));
vi.mock("@/lib/db", () => ({ getCallEvents }));

import { POST } from "@/app/api/dev/phone/turn/route";
import { CALLBACK_BUTTONS } from "@/lib/dev-phone-buttons";

const FULL_NUMBER = "+14165550123";

function turn() {
  return POST(
    new Request("http://localhost/api/dev/phone/turn", {
      method: "POST",
      body: JSON.stringify({ callSid: "CA1", speechResult: "hello" }),
    }),
  );
}

function result(nextState: string, hangup?: boolean) {
  return {
    kind: "reply",
    call: { id: "c1" },
    reply: "Oh dear, where are my glasses?",
    nextState,
    riskScore: 80,
    riskLevel: "high",
    ...(hangup ? { hangup } : {}),
  };
}

beforeEach(() => {
  vi.stubEnv("ENABLE_DEV_TOOLS", "true");
  processTurn.mockReset().mockResolvedValue(result("screening"));
  getCallEvents.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("dev phone callback buttons", () => {
  it("maps exact label -> digit -> outcome", () => {
    expect(CALLBACK_BUTTONS.map((b) => [b.label, b.digit, b.outcome])).toEqual([
      ["Press 1: not me, I'm safe", "1", "denied"],
      ["Press 2: it's really me", "2", "confirmed"],
      ["No answer", "0", "no_answer"],
    ]);
  });
});

describe("POST /api/dev/phone/turn", () => {
  it("never returns the full callback number", async () => {
    getCallEvents.mockResolvedValue([
      {
        id: "e1",
        type: "callback_started",
        payload: { type: "callback_started", target_phone: FULL_NUMBER },
      },
    ]);

    const res = await turn();
    const text = JSON.stringify(await res.clone().json());
    const json = await res.json();

    expect(json.callbackPending).toBe(true);
    expect(json.callbackTarget).toContain("***0123");
    expect(text).not.toContain(FULL_NUMBER);
    expect(text).not.toContain("4165550123");
  });

  it("reports callbackPending false when no callback is open", async () => {
    const json = await (await turn()).json();
    expect(json.callbackPending).toBe(false);
  });

  it("does not end the call while state is time_wasted", async () => {
    processTurn.mockResolvedValue(result("time_wasted"));
    const json = await (await turn()).json();

    expect(json.state).toBe("time_wasted");
    expect(json.hangup).toBe(false);
  });

  it("ends the call when the engine hangs up", async () => {
    processTurn.mockResolvedValue(result("completed", true));
    const json = await (await turn()).json();

    expect(json).toMatchObject({ state: "completed", hangup: true });
  });
});
