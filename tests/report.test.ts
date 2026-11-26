import { describe, it, expect, vi } from "vitest";

const db = vi.hoisted(() => ({
  adminDb: vi.fn(),
  FraudReportSchema: { parse: (x: unknown) => x },
  getCallById: vi.fn(),
  getCallEvents: vi.fn(),
  getFraudReport: vi.fn(),
  createFraudReport: vi.fn(),
}));
vi.mock("@/lib/db", () => db);

import { buildAndStoreReport, buildCafcText, FraudReportDataSchema } from "@/lib/report";

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

describe("buildAndStoreReport", () => {
  it("builds a report from the mocked call and events", async () => {
    db.getFraudReport.mockResolvedValue(null);
    db.getCallById.mockResolvedValue({
      id: "c1",
      started_at: "2026-01-01T00:00:00.000Z",
      from_number: "+15550100000",
      claimed_identity: "CRA agent",
      requested_amount: "$500",
      payment_method: "gift card",
      risk_score: 90,
      risk_level: "high",
      summary: "Gift card demand.",
      is_simulated: false,
    });
    db.getCallEvents.mockResolvedValue([
      { type: "transcript", payload: { speaker: "caller", text: "Buy gift cards" } },
      { type: "red_flag", payload: { flag: "payment_method", quote: "Buy gift cards" } },
    ]);
    db.createFraudReport.mockImplementation(async (r: unknown) => r);

    const row = (await buildAndStoreReport("c1")) as unknown as {
      call_id: string;
      report: { red_flags: Array<{ quote: string }>; scam_type: string; amount: string };
    };

    expect(row.call_id).toBe("c1");
    expect(row.report.red_flags[0]!.quote).toBe("Buy gift cards");
    expect(row.report.amount).toBe("$500");
    expect(row.report.scam_type).toBe("CRA / IRS impersonation");
  });

  it("two concurrent builds return the same row id and create one row", async () => {
    const rows = new Map<string, { id: string; call_id: string; report: unknown }>();
    db.getFraudReport.mockImplementation(async (callId: string) => {
      await Promise.resolve();
      return rows.get(callId) ?? null;
    });
    db.getCallById.mockResolvedValue({
      id: "c2",
      started_at: "2026-01-01T00:00:00.000Z",
      from_number: "+15550100000",
      claimed_identity: null,
      requested_amount: null,
      payment_method: null,
      risk_score: 90,
      risk_level: "high",
      summary: null,
      is_simulated: false,
    });
    db.getCallEvents.mockResolvedValue([]);
    let inserts = 0;
    db.createFraudReport.mockImplementation(
      async (r: { call_id: string; report: unknown }) => {
        await Promise.resolve();
        if (rows.has(r.call_id)) {
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        }
        inserts++;
        const row = { id: `r${inserts}`, call_id: r.call_id, report: r.report };
        rows.set(r.call_id, row);
        return row;
      },
    );

    const [a, b] = await Promise.all([buildAndStoreReport("c2"), buildAndStoreReport("c2")]);

    expect(a.id).toBe(b.id);
    expect(rows.size).toBe(1);
    expect(inserts).toBe(1);
  });

  it("rethrows non-unique insert errors", async () => {
    db.getFraudReport.mockResolvedValue(null);
    db.getCallById.mockResolvedValue({
      id: "c3",
      started_at: "2026-01-01T00:00:00.000Z",
      from_number: "+15550100000",
      claimed_identity: null,
      requested_amount: null,
      payment_method: null,
      risk_score: 1,
      risk_level: "high",
      summary: null,
      is_simulated: false,
    });
    db.getCallEvents.mockResolvedValue([]);
    db.createFraudReport.mockRejectedValue(Object.assign(new Error("boom"), { code: "XX000" }));
    await expect(buildAndStoreReport("c3")).rejects.toThrow("boom");
  });

  it("throws when the call does not exist", async () => {
    db.getFraudReport.mockResolvedValue(null);
    db.getCallById.mockResolvedValue(null);
    await expect(buildAndStoreReport("nope")).rejects.toThrow("Call not found");
  });
});
