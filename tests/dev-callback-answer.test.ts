import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { record, getCallBySid } = vi.hoisted(() => ({
  record: vi.fn(),
  getCallBySid: vi.fn(),
}));

vi.mock("@/lib/callback", () => ({ recordCallbackResult: record }));
vi.mock("@/lib/db", () => ({ getCallBySid }));

import { POST } from "@/app/api/dev/phone/callback-answer/route";

const CALL = { id: "c1", state: "screening", risk_score: 45, risk_level: "medium" };

function answer(digit: string, callSid = "CA1") {
  return POST(
    new Request("http://localhost/api/dev/phone/callback-answer", {
      method: "POST",
      body: JSON.stringify({ callSid, digit }),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("ENABLE_DEV_TOOLS", "true");
  record.mockReset();
  getCallBySid.mockReset().mockResolvedValue(CALL);
  record.mockResolvedValue({ recorded: true, call: CALL, level: "low", score: 5, state: "screening" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/dev/phone/callback-answer", () => {
  it.each([
    ["1", "denied"],
    ["2", "confirmed"],
    ["0", "no_answer"],
  ])("digit %s records %s through recordCallbackResult", async (digit, outcome) => {
    const res = await answer(digit);
    const json = await res.json();

    expect(record).toHaveBeenCalledWith("CA1", outcome);
    expect(json).toMatchObject({ outcome, recorded: true, riskScore: 5, riskLevel: "low" });
  });

  it("returns 404 in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await answer("1");

    expect(res.status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown call", async () => {
    getCallBySid.mockResolvedValue(null);
    expect((await answer("1")).status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });
});
