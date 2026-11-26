import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/providers", () => ({ getTelephony: vi.fn() }));
vi.mock("@/lib/db", () => ({
  getCallEvents: vi.fn(),
  getAlertRecipients: vi.fn(),
  getHousehold: vi.fn(),
  appendEvent: vi.fn(),
}));

import { buildAlertSms, type AlertContext } from "@/lib/alerts";
import type { CallRow } from "@/lib/db";

const call: CallRow = {
  id: "00000000-0000-4000-8000-000000000001",
  household_id: "00000000-0000-4000-8000-000000000002",
  call_sid: "CA1",
  from_number: "+15550100000",
  claimed_identity: null,
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
};

function ctx(simulated: boolean, who: string | null = "CRA"): AlertContext {
  return {
    call: { ...call, is_simulated: simulated },
    level: "high",
    claimedIdentity: who,
    requestedAmount: "$500",
    paymentMethod: "gift card",
    safeWordResult: "failed",
    callbackResult: "denied",
  };
}

const URL = "https://ghostline.example/calls/abc";

describe("buildAlertSms SIMULATED label", () => {
  it("prefixes SIMULATED: for a simulated call", () => {
    expect(buildAlertSms(ctx(true), URL).startsWith("SIMULATED: GHOSTLINE HIGH")).toBe(true);
  });

  it("has no prefix for a real call", () => {
    expect(buildAlertSms(ctx(false), URL)).not.toContain("SIMULATED");
  });

  it("keeps total length <= 320 with the prefix and long values", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), fc.boolean(), (who, sim) => {
        const sms = buildAlertSms(ctx(sim, who), URL);
        expect(sms.length).toBeLessThanOrEqual(320);
        expect(sms.startsWith("SIMULATED: ")).toBe(sim);
      }),
    );
  });
});
