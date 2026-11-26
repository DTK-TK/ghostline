import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { deriveLiveStatus } from "@/lib/live-status";
import type { CallEventRow, CallRow } from "@/lib/db";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const call: CallRow = {
  id: "00000000-0000-4000-8000-000000000001",
  household_id: "00000000-0000-4000-8000-000000000002",
  call_sid: "CA1",
  from_number: "+15550100000",
  claimed_identity: null,
  state: "screening",
  risk_score: 55,
  risk_level: "medium",
  outcome: null,
  started_at: iso(0),
  ended_at: null,
  summary: null,
  is_simulated: true,
  requested_amount: null,
  payment_method: null,
};

let n = 0;
function ev(type: CallEventRow["type"], sec: number, payload: Record<string, unknown>): CallEventRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    call_id: call.id,
    type,
    payload: { type, ...payload },
    created_at: iso(sec),
  };
}
const say = (sec: number, speaker: "caller" | "system", text: string) =>
  ev("transcript", sec, { speaker, text });
const attempt = (sec: number, matched: boolean, text = "[redacted]") =>
  ev("safe_word_attempt", sec, { matched, attempt: text });

describe("deriveLiveStatus", () => {
  it("safe word: not asked, asked, passed, failed with attempts", () => {
    expect(deriveLiveStatus(call, [], T0).safeWord).toBe("not_asked");

    const asked = [say(1, "system", "What is the family safe word?")];
    expect(deriveLiveStatus(call, asked, T0)).toMatchObject({ safeWord: "asked", attempts: 0 });

    const passed = [...asked, attempt(2, true)];
    expect(deriveLiveStatus(call, passed, T0)).toMatchObject({ safeWord: "passed", attempts: 1 });

    const failed = [...asked, attempt(2, false), attempt(3, false)];
    expect(deriveLiveStatus(call, failed, T0)).toMatchObject({ safeWord: "failed", attempts: 2 });
  });

  it("callback: calling, pending, denied (and confirmed)", () => {
    const started = ev("callback_started", 10, { target_phone: "+15551234567" });
    const calling = deriveLiveStatus(call, [started], T0 + 12_000);
    expect(calling.callback).toBe("calling");
    expect(calling.callbackTarget).toBe("\u2022\u2022\u2022\u2022 4567");

    expect(deriveLiveStatus(call, [started], T0 + 30_000).callback).toBe("pending");

    const denied = ev("callback_result", 20, { outcome: "denied" });
    expect(deriveLiveStatus(call, [started, denied], T0 + 30_000).callback).toBe("denied");

    const ok = ev("callback_result", 20, { outcome: "confirmed" });
    expect(deriveLiveStatus(call, [started, ok], T0 + 30_000).callback).toBe("confirmed");
    expect(deriveLiveStatus(call, [], T0).callback).toBe("not_initiated");
  });

  it("timer runs while the persona is active, then freezes", () => {
    const start = ev("state_change", 5, { from: "screening", to: "time_wasted" });
    const running = deriveLiveStatus({ ...call, state: "time_wasted" }, [start], T0 + 25_000);
    expect(running.timeWasted).toMatchObject({ seconds: 20, running: true, endedAt: null });

    const later = deriveLiveStatus({ ...call, state: "time_wasted" }, [start], T0 + 40_000);
    expect(later.timeWasted?.seconds).toBe(35);

    const exit = ev("state_change", 65, { from: "time_wasted", to: "completed", reason: "limit" });
    const done = { ...call, state: "completed" as const, ended_at: iso(65) };
    const f1 = deriveLiveStatus(done, [start, exit], T0 + 70_000);
    const f2 = deriveLiveStatus(done, [start, exit], T0 + 500_000);
    expect(f1.timeWasted).toMatchObject({ seconds: 60, running: false });
    expect(f2.timeWasted?.seconds).toBe(60);
  });

  it("timeWasted is null when the persona never ran", () => {
    expect(deriveLiveStatus(call, [say(1, "caller", "hi")], T0).timeWasted).toBeNull();
  });

  it("flags carry the caller quote; transcript is ordered; simulated and level pass through", () => {
    const events = [
      ev("red_flag", 3, { flag: "payment_method", detail: "rules-only" }),
      say(2, "system", "Why are you calling?"),
      say(1, "caller", "Buy gift cards right now"),
    ];
    const out = deriveLiveStatus(call, events, T0);
    expect(out.flags).toEqual([
      { id: "payment_method", label: expect.any(String), quote: "Buy gift cards right now" },
    ]);
    expect(out.transcript.map((t) => t.speaker)).toEqual(["caller", "ghostline"]);
    expect(out).toMatchObject({ level: "medium", score: 55, simulated: true, state: "screening" });
  });

  it("never exposes safe word attempt text", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{12,20}$/), fc.boolean(), (secret, matched) => {
        const out = deriveLiveStatus(call, [attempt(1, matched, secret)], T0);
        expect(JSON.stringify(out)).not.toContain(secret);
      }),
    );
  });
});
