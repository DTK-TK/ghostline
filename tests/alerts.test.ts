import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/providers", () => ({ getTelephony: vi.fn() }));
vi.mock("@/lib/db", () => ({
  getCallEvents: vi.fn(),
  getAlertRecipients: vi.fn(),
  getHousehold: vi.fn(),
  appendEvent: vi.fn(),
}));

import { buildAlertSms, buildChecklistSms, paymentBranch, type AlertContext } from "@/lib/alerts";
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

describe("buildAlertSms hostile caller text", () => {
  const LINK = "https://ghostline.example/calls/00000000-0000-4000-8000-000000000001";
  const nasty = fc.oneof(
    fc.string({ unit: "binary", maxLength: 400 }),
    fc.string({ maxLength: 400 }),
    fc
      .array(
        fc.constantFrom(
          "http://evil.com/x", "https://a.b.co/pay?x=1", "www.scam.net", "pay.me.now",
          "\u0000", "\u001b[31m", "\n", "\t", "\u2026", "\u2014", "\u00e9", "\u{1F4B0}",
          " ", "a".repeat(80), "CRA", "$500",
        ),
        { maxLength: 30 },
      )
      .map((p) => p.join("")),
  );

  it("is ASCII, <= 320, ends with the exact link, and has no other URL", () => {
    fc.assert(
      fc.property(nasty, nasty, nasty, fc.boolean(), (who, amt, pay, sim) => {
        const c = ctx(sim, who);
        c.requestedAmount = amt;
        c.paymentMethod = pay;
        const sms = buildAlertSms(c, LINK);
        expect(/^[\x20-\x7e]*$/.test(sms)).toBe(true);
        expect(sms.length).toBeLessThanOrEqual(320);
        expect(sms.endsWith(LINK)).toBe(true);
        const rest = sms.slice(0, sms.length - LINK.length);
        expect(rest).not.toMatch(/https?:|www\./i);
        expect(rest).not.toMatch(/[a-z0-9-]\.[a-z]{2,}/i);
      }),
      { numRuns: 500 },
    );
  });

  it("caps each field separately and keeps the link on long input", () => {
    const c = ctx(false, "Q".repeat(100));
    c.requestedAmount = "9".repeat(100);
    c.paymentMethod = "P".repeat(100);
    const sms = buildAlertSms(c, "https://gl.example/c/1");
    expect(sms).toContain(`${"Q".repeat(37)}...`);
    expect(sms).not.toContain("Q".repeat(38));
    expect(sms).toContain(`${"9".repeat(17)}...`);
    expect(sms.endsWith("https://gl.example/c/1")).toBe(true);
  });

  it("strips URLs and uses plain ASCII for ellipsis and dashes", () => {
    const sms = buildAlertSms(ctx(false, "Bob \u2014 see http://evil.com/x now\u2026"), LINK);
    expect(sms).toMatch(/claims to be Bob see now\.+ Amount/);
  });
});

describe("buildChecklistSms", () => {
  const LINK = "https://ghostline.example/calls/00000000-0000-4000-8000-000000000001";

  it("gift card branch names the contact and matches the design example shape", () => {
    const sms = buildChecklistSms("Sun", "Alex", "gift card", LINK);
    expect(sms).toContain("1) Call Alex first.");
    expect(sms).toContain("3) Gift card: keep the card and receipt, call the issuer now.");
    expect(sms.endsWith(LINK)).toBe(true);
  });

  it("transfer branch (crypto, wire, e-transfer)", () => {
    for (const m of ["bitcoin", "wire transfer", "Interac e-Transfer"]) {
      expect(buildChecklistSms("Sun", "Alex", m, LINK)).toContain("ask the bank to stop or recall it");
    }
  });

  it("courier branch", () => {
    expect(buildChecklistSms("Sun", "Alex", "courier pickup", LINK)).toContain("Hand nothing to any courier");
  });

  it("other branch for anything else, including whole-word only matching", () => {
    expect(buildChecklistSms("Sun", "Alex", "personal cheque", LINK)).toContain("call the bank or card issuer now");
    expect(paymentBranch("wired")).toBe("other");
    expect(paymentBranch(null)).toBe("other");
  });

  it("falls back to 'a family member' when there is no contact", () => {
    expect(buildChecklistSms("Sun", null, "gift card", LINK)).toContain("Call a family member first.");
    expect(buildChecklistSms("Sun", "", "gift card", LINK)).toContain("Call a family member first.");
  });

  it("never includes the caller's payment text", () => {
    const sms = buildChecklistSms("Sun", "Alex", "gift card http://evil.com ZZZQ", LINK);
    expect(sms).not.toContain("ZZZQ");
    expect(sms).not.toContain("evil");
  });

  it("is ASCII, <= 320, ends with the link, and has no other URL for any input", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 300 }),
        fc.string({ maxLength: 300 }),
        fc.oneof(fc.string({ maxLength: 300 }), fc.constantFrom("gift card", "bitcoin", "courier", "cash")),
        (family, contact, pay) => {
          const sms = buildChecklistSms(family, contact, pay, LINK);
          expect(/^[\x20-\x7e]*$/.test(sms)).toBe(true);
          expect(sms.length).toBeLessThanOrEqual(320);
          expect(sms.endsWith(LINK)).toBe(true);
          const rest = sms.slice(0, sms.length - LINK.length);
          expect(rest).not.toMatch(/https?:|www\./i);
          expect(rest).not.toMatch(/[a-z0-9-]\.[a-z]{2,}/i);
        },
      ),
      { numRuns: 300 },
    );
  });
});
