import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getCallBySid: vi.fn(),
  getCallEvents: vi.fn(),
  getHousehold: vi.fn(),
  getFraudReport: vi.fn(),
  createFraudReport: vi.fn(),
}));

import { buildCafcText, FraudReportDataSchema } from "@/lib/report";

const base = {
  date_time: "2026-01-01T00:00:00.000Z",
  caller_number: "+15550100000",
  claimed_identity: "CRA",
  scam_type: "CRA / IRS impersonation",
  amount: null,
  payment_method: null,
  red_flags: [],
  safe_word_result: "not asked" as const,
  callback_result: "not initiated" as const,
  transcript: [],
  risk_score: 80,
  risk_level: "high",
  summary: null,
};

describe("buildCafcText SIMULATED label", () => {
  it("marks a simulated report clearly at top and bottom", () => {
    const text = buildCafcText(FraudReportDataSchema.parse({ ...base, is_simulated: true }));
    expect(text.startsWith("*** SIMULATED")).toBe(true);
    expect(text).toContain("DO NOT FILE THIS REPORT");
    expect(text).toContain("SIMULATED: do not file this report.");
  });

  it("has no SIMULATED text for a real report, and old reports default to real", () => {
    const text = buildCafcText(FraudReportDataSchema.parse(base));
    expect(text).not.toContain("SIMULATED");
  });
});

describe("buildCafcText red-flag quotes", () => {
  it("shows each flag with the caller's quote", () => {
    const data = FraudReportDataSchema.parse({
      ...base,
      red_flags: [{ flag_id: "payment_method", quote: "Buy a gift card" }],
    });
    expect(data.red_flags[0]!.quote).toBe("Buy a gift card");
    expect(buildCafcText(data)).toContain('  - payment_method: "Buy a gift card"');
  });
});