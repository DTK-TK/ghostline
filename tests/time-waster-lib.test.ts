import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENTRY_LINE,
  GOODBYE_LINE,
  GRANDMOTHER_LINES,
  elapsedSeconds,
  enterHighRisk,
  displaySeconds,
  formatMmSs,
  limitSeconds,
  startedAtFrom,
  timeWastedSummary,
} from "@/lib/time-waster";

const supa = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        supa.inserted.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: {
                id: "22222222-2222-4222-8222-222222222222",
                created_at: "2026-01-01T00:00:00.000Z",
                ...row,
              },
              error: null,
            }),
          }),
        };
      },
    }),
  }),
}));

import { appendEvent } from "@/lib/db";

afterEach(() => vi.unstubAllEnvs());

describe("appendEvent state_change payload", () => {
  const call_id = "11111111-1111-4111-8111-111111111111";
  const base = { call_id, type: "state_change" as const };

  it("accepts a legacy payload without the new fields", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
    await expect(
      appendEvent({ ...base, payload: { type: "state_change", from: "screening", to: "completed" } }),
    ).resolves.toBeDefined();
  });

  it("accepts an entry payload", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
    await expect(
      appendEvent({
        ...base,
        payload: {
          type: "state_change",
          from: "screening",
          to: "time_wasted",
          started_at: "2026-01-01T00:00:10.000Z",
        },
      }),
    ).resolves.toBeDefined();
  });

  it("accepts an exit payload", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
    await expect(
      appendEvent({
        ...base,
        payload: {
          type: "state_change",
          from: "time_wasted",
          to: "completed",
          started_at: "2026-01-01T00:00:10.000Z",
          ended_at: "2026-01-01T00:03:10.000Z",
          seconds: 180,
          reason: "limit",
        },
      }),
    ).resolves.toBeDefined();
  });
});

function ev(payload: Record<string, unknown>, created_at: string) {
  return { type: "state_change" as const, payload, created_at };
}

describe("limitSeconds", () => {
  it("defaults to 180 when unset", () => {
    vi.stubEnv("TIME_WASTER_SECONDS", "");
    expect(limitSeconds()).toBe(180);
  });
  it.each([
    ["5", 5],
    ["1", 1],
    ["180", 180],
    ["999", 180],
    ["abc", 180],
    ["0", 180],
    ["-4", 180],
    ["30s", 30],
  ])("%s -> %i", (raw, expected) => {
    vi.stubEnv("TIME_WASTER_SECONDS", raw);
    expect(limitSeconds()).toBe(expected);
  });
  it("reads the env on every call", () => {
    vi.stubEnv("TIME_WASTER_SECONDS", "7");
    expect(limitSeconds()).toBe(7);
    vi.stubEnv("TIME_WASTER_SECONDS", "9");
    expect(limitSeconds()).toBe(9);
  });
});

describe("startedAtFrom / elapsedSeconds / timeWastedSummary", () => {
  const entry = ev(
    { from: "screening", to: "time_wasted", started_at: "2026-01-01T00:00:10.000Z" },
    "2026-01-01T00:00:11.000Z",
  );

  it("prefers payload.started_at, falls back to created_at, null without entry", () => {
    expect(startedAtFrom([entry])).toBe("2026-01-01T00:00:10.000Z");
    expect(
      startedAtFrom([ev({ from: "screening", to: "time_wasted" }, "2026-01-01T00:00:11.000Z")]),
    ).toBe("2026-01-01T00:00:11.000Z");
    expect(startedAtFrom([ev({ from: "initiated", to: "screening" }, "2026-01-01T00:00:00.000Z")])).toBeNull();
  });

  it("computes elapsed whole seconds", () => {
    expect(elapsedSeconds([entry], new Date("2026-01-01T00:00:15.900Z"))).toBe(5);
    expect(elapsedSeconds([], new Date())).toBe(0);
  });

  it("summary is running before the exit event and frozen after", () => {
    const running = timeWastedSummary([entry], new Date("2026-01-01T00:00:13.000Z"));
    expect(running).toEqual({
      startedAt: "2026-01-01T00:00:10.000Z",
      endedAt: null,
      seconds: 3,
      running: true,
    });
    const exit = ev(
      { from: "time_wasted", to: "completed", ended_at: "2026-01-01T00:03:10.000Z" },
      "2026-01-01T00:03:10.500Z",
    );
    const done = timeWastedSummary([entry, exit], new Date("2026-01-01T01:00:00.000Z"));
    expect(done).toMatchObject({ seconds: 180, running: false, endedAt: "2026-01-01T00:03:10.000Z" });
    expect(timeWastedSummary([], new Date())).toBeNull();
  });
});

describe("formatMmSs", () => {
  it("formats", () => {
    expect(formatMmSs(180)).toBe("03:00");
    expect(formatMmSs(0)).toBe("00:00");
    expect(formatMmSs(65)).toBe("01:05");
    expect(formatMmSs(-3)).toBe("00:00");
  });
});

describe("scripted lines", () => {
  const lines = [ENTRY_LINE, GOODBYE_LINE, ...GRANDMOTHER_LINES];
  it.each(lines)("is short and safe: %s", (line) => {
    expect(line.trim().split(/\s+/).length).toBeLessThan(20);
    expect(line.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
    expect(line).not.toMatch(/scam|fraud|police|report|suspicious|risk|record/i);
  });
});

describe("enterHighRisk", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  it("starts the persona when enabled", () => {
    expect(
      enterHighRisk({ call: { state: "screening" }, household: { time_waster_enabled: true }, now }),
    ).toEqual({ state: "time_wasted", extra: { started_at: now.toISOString() } });
  });
  it("blocks when disabled", () => {
    expect(
      enterHighRisk({ call: { state: "screening" }, household: { time_waster_enabled: false }, now }),
    ).toEqual({ state: "scam_blocked", extra: {}, outcome: "blocked", hangup: true });
  });
  it("leaves persona and terminal states alone", () => {
    for (const state of ["time_wasted", "scam_blocked", "completed"] as const) {
      expect(
        enterHighRisk({ call: { state }, household: { time_waster_enabled: true }, now }),
      ).toEqual({ state, extra: {} });
    }
  });
});

describe("displaySeconds", () => {
  const entry = ev(
    { from: "screening", to: "time_wasted", started_at: "2026-01-01T00:00:10.000Z" },
    "2026-01-01T00:00:10.200Z",
  );
  const exit = ev(
    { from: "time_wasted", to: "completed", ended_at: "2026-01-01T00:00:20.000Z" },
    "2026-01-01T00:00:20.100Z",
  );

  it("counts up from startedAt while running", () => {
    const s = timeWastedSummary([entry], new Date("2026-01-01T00:00:12.000Z"))!;
    expect(displaySeconds(s, Date.parse("2026-01-01T00:00:15.000Z"))).toBe(5);
    expect(displaySeconds(s, Date.parse("2026-01-01T00:00:05.000Z"))).toBe(0);
  });

  it("is frozen at the final value after the exit event", () => {
    const s = timeWastedSummary([entry, exit], new Date("2026-01-01T00:00:30.000Z"))!;
    expect(displaySeconds(s, Date.parse("2026-01-01T01:00:00.000Z"))).toBe(10);
    expect(formatMmSs(displaySeconds(s, Date.now()))).toBe("00:10");
  });

  it("has no summary for a call that never entered time_wasted", () => {
    expect(timeWastedSummary([], new Date())).toBeNull();
  });
});
