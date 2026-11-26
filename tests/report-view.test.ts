import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatReportTime, parseReportId, riskDisplay } from "@/lib/report-view";

describe("parseReportId", () => {
  it("accepts a uuid and rejects bad ids", () => {
    const id = "3f2b8c1e-9a4d-4e6b-8c2a-1d5e7f9a0b3c";
    expect(parseReportId(id)).toBe(id);
    for (const bad of ["not-a-uuid", "", "123", "../etc", undefined, null]) {
      expect(parseReportId(bad)).toBeNull();
    }
  });

  it("accepts every generated uuid and rejects non-uuid strings", () => {
    fc.assert(fc.property(fc.uuid(), (u) => parseReportId(u) === u));
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (s) => parseReportId(s) === null),
    );
  });
});

describe("riskDisplay", () => {
  it("pairs each level with a text label and its colour", () => {
    expect(riskDisplay("low")).toMatchObject({ label: "LOW" });
    expect(riskDisplay("low").className).toContain("green-500");
    expect(riskDisplay("medium").label).toBe("MEDIUM");
    expect(riskDisplay("medium").className).toContain("amber-500");
    expect(riskDisplay("high").label).toBe("HIGH");
    expect(riskDisplay("high").className).toContain("red-500");
  });

  it("treats critical and unknown values as HIGH", () => {
    expect(riskDisplay("critical").label).toBe("HIGH");
    expect(riskDisplay("???").label).toBe("HIGH");
  });
});

describe("formatReportTime", () => {
  it("returns ISO UTC with a Z", () => {
    expect(formatReportTime("2026-01-05T09:03:00-05:00")).toBe("2026-01-05T14:03:00Z");
  });
  it("returns an unparseable value unchanged", () => {
    expect(formatReportTime("later")).toBe("later");
  });
});
