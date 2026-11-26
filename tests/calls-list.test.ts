import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatStart } from "@/lib/format-start";
import { buildPage, PAGE_SIZE, parseCursor, toCallListRow } from "@/lib/calls-list";
import type { CallRow } from "@/lib/db";

const base: CallRow = {
  id: "11111111-1111-4111-8111-111111111111",
  household_id: "22222222-2222-4222-8222-222222222222",
  call_sid: "CA1",
  from_number: "+15551236543",
  claimed_identity: "Bank agent",
  state: "completed",
  risk_score: 82,
  risk_level: "critical",
  outcome: "blocked",
  started_at: "2026-12-04T15:30:00.000Z",
  ended_at: null,
  summary: null,
  is_simulated: true,
};

describe("parseCursor", () => {
  it("accepts ISO datetimes and normalises them", () => {
    expect(parseCursor("2026-12-04T15:30:00Z")).toBe("2026-12-04T15:30:00.000Z");
    expect(parseCursor("2026-12-04T10:30:00-05:00")).toBe("2026-12-04T15:30:00.000Z");
  });
  it("rejects junk and filter injection", () => {
    for (const bad of [null, undefined, "", "yesterday", "2026-12-04", "x),id.eq.1", 5]) {
      expect(parseCursor(bad)).toBeNull();
    }
  });
});

describe("toCallListRow", () => {
  it("masks the number, maps critical to high, carries report id", () => {
    const row = toCallListRow(base, "rep-1");
    expect(row.from).toMatch(/6543$/);
    expect(row.from).not.toContain("555123");
    expect(row.level).toBe("high");
    expect(row.reportId).toBe("rep-1");
    expect(row.simulated).toBe(true);
    expect(Object.keys(row)).not.toContain("household_id");
  });
  it("keeps unscored calls unscored", () => {
    const row = toCallListRow({ ...base, risk_level: null, risk_score: null }, null);
    expect(row.level).toBeNull();
    expect(row.score).toBeNull();
    expect(row.reportId).toBeNull();
  });
});

describe("buildPage", () => {
  const mk = (n: number): CallRow[] =>
    Array.from({ length: n }, (_, i) => ({
      ...base,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      started_at: new Date(Date.UTC(2026, 11, 4) - i * 60000).toISOString(),
    }));

  it("no cursor when 25 or fewer rows", () => {
    expect(buildPage(mk(25), {}).nextCursor).toBeNull();
  });
  it("26 rows: shows 25 and cursors on the 25th", () => {
    const calls = mk(26);
    const page = buildPage(calls, {});
    expect(page.rows).toHaveLength(PAGE_SIZE);
    expect(page.nextCursor).toBe(calls[24].started_at);
  });
  it("property: never shows more than the page size", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), (n) => {
        const page = buildPage(mk(n), {});
        expect(page.rows.length).toBeLessThanOrEqual(PAGE_SIZE);
        expect(page.nextCursor !== null).toBe(n > PAGE_SIZE);
      }),
    );
  });
});

describe("formatStart", () => {
  it("includes a time zone name", () => {
    expect(formatStart("2026-12-04T15:30:00.000Z", "en-US")).toMatch(/[A-Z]{2,5}|GMT/);
  });
  it("handles bad input", () => {
    expect(formatStart("nope")).toBe("Unknown");
  });
});
