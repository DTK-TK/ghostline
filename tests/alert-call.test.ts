import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  call: null as Record<string, unknown> | null,
  events: [] as Record<string, unknown>[],
  sendAlerts: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getCallById: async () => m.call,
  getCallEvents: async () => m.events,
}));
vi.mock("@/lib/alerts", () => ({ sendAlerts: m.sendAlerts }));

import { alertCall } from "@/lib/alert-call";

function setCall(over: Record<string, unknown>) {
  m.call = {
    id: "c1",
    state: "screening",
    ended_at: null,
    risk_level: "low",
    claimed_identity: "CRA",
    requested_amount: "$500",
    payment_method: "gift card",
    ...over,
  };
}

beforeEach(() => {
  m.events = [];
  m.sendAlerts.mockReset();
  m.sendAlerts.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("alertCall", () => {
  it("HIGH sends immediately with context built from the database", async () => {
    setCall({ risk_level: "high" });
    m.events = [
      { type: "safe_word_attempt", payload: { matched: false } },
      { type: "callback_started", payload: {} },
    ];
    await alertCall("c1");
    expect(m.sendAlerts).toHaveBeenCalledTimes(1);
    expect(m.sendAlerts.mock.calls[0]![0]).toMatchObject({
      level: "high",
      claimedIdentity: "CRA",
      requestedAmount: "$500",
      paymentMethod: "gift card",
      safeWordResult: "failed",
      callbackResult: "pending",
    });
  });

  it("MEDIUM waits for the end, unless a message was taken", async () => {
    setCall({ risk_level: "medium" });
    await alertCall("c1");
    expect(m.sendAlerts).not.toHaveBeenCalled();
    await alertCall("c1", { messageTaken: true });
    expect(m.sendAlerts).toHaveBeenCalledTimes(1);
    setCall({ risk_level: "medium", ended_at: "2026-01-01T00:00:00Z" });
    await alertCall("c1");
    expect(m.sendAlerts).toHaveBeenCalledTimes(2);
  });

  it("LOW and missing calls send nothing", async () => {
    setCall({ risk_level: "low", ended_at: "2026-01-01T00:00:00Z" });
    await alertCall("c1");
    m.call = null;
    await alertCall("c1");
    expect(m.sendAlerts).not.toHaveBeenCalled();
  });

  it("never throws, and logs no phone numbers", async () => {
    setCall({ risk_level: "high" });
    m.sendAlerts.mockRejectedValue(new Error("fail +15551234567"));
    await expect(alertCall("c1")).resolves.toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("5551234567");
  });
});
