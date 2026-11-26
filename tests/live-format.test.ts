import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { clampScore, riskDisplay, RISK_MARKS } from "@/lib/risk-display";
import {
  callbackText,
  connectionView,
  formatDuration,
  isNearBottom,
  safeWordText,
} from "@/lib/live-format";

describe("riskDisplay", () => {
  it("maps each level to a label and colour", () => {
    expect(riskDisplay("low")).toMatchObject({ label: "LOW", bar: "bg-green-500" });
    expect(riskDisplay("medium")).toMatchObject({ label: "MEDIUM", bar: "bg-amber-500" });
    expect(riskDisplay("high")).toMatchObject({ label: "HIGH", bar: "bg-red-500" });
  });
  it("has marks at 40 and 70", () => {
    expect([...RISK_MARKS]).toEqual([40, 70]);
  });
  it("clamps any number into 0..100", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (n) => {
        const c = clampScore(n);
        return c >= 0 && c <= 100 && Number.isInteger(c);
      }),
    );
  });
});

describe("formatDuration", () => {
  it("formats mm:ss", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(125)).toBe("02:05");
    expect(formatDuration(-5)).toBe("00:00");
    expect(formatDuration(4500)).toBe("75:00");
  });
});

describe("status text", () => {
  it("shows attempt count but nothing else for a failed safe word", () => {
    expect(safeWordText("failed", 2)).toBe("Failed (2 of 2 attempts)");
    expect(safeWordText("passed", 1)).toBe("Passed");
  });
  it("masks the callback target as given", () => {
    expect(callbackText("calling", "\u2022\u2022\u2022\u2022 1234")).toContain("1234");
    expect(callbackText("denied", null)).toMatch(/not them/);
  });
});

describe("connectionView", () => {
  const t = Date.parse("2026-01-01T00:00:10Z");
  it("reports reconnecting, connecting and live", () => {
    expect(connectionView(null, true, t).label).toBe("Reconnecting...");
    expect(connectionView(null, false, t).label).toBe("Connecting...");
    expect(connectionView(new Date(t - 3000), false, t)).toEqual({ label: "Live, updated 3 s ago", ok: true });
  });
});

describe("isNearBottom", () => {
  it("detects the bottom and a scrolled-up viewer", () => {
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 500, clientHeight: 100 })).toBe(false);
  });
});
