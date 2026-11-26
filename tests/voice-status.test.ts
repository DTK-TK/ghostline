import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BASE_URL, twilioRequest, callFixture } from "./helpers/voice";

const db = vi.hoisted(() => ({
  getCallBySid: vi.fn(),
  updateCall: vi.fn(),
}));
vi.mock("@/lib/db", () => db);

import { POST } from "@/app/api/voice/status/route";

function status(CallStatus: string) {
  return POST(twilioRequest("/api/voice/status", { CallSid: "CA_TEST_0001", CallStatus }));
}

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", BASE_URL);
  db.getCallBySid.mockResolvedValue(callFixture());
  db.updateCall.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/voice/status", () => {
  it.each([
    ["completed", "completed", "transferred"],
    ["busy", "completed", "dropped"],
    ["failed", "failed", "unknown"],
    ["no-answer", "completed", "dropped"],
    ["canceled", "completed", "dropped"],
  ])("CallStatus=%s sets state=%s outcome=%s and returns an empty 204", async (callStatus, state, outcome) => {
    const res = await status(callStatus);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(db.updateCall).toHaveBeenCalledWith(
      "CA_TEST_0001",
      expect.objectContaining({ state, outcome, ended_at: expect.any(String) }),
    );
  });

  it("keeps an outcome the turn handler already set", async () => {
    db.getCallBySid.mockResolvedValue(callFixture({ outcome: "blocked" }));

    await status("completed");

    const patch = db.updateCall.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("outcome");
    expect(patch["state"]).toBe("completed");
  });

  it("unknown CallSid: 204 and no update", async () => {
    db.getCallBySid.mockResolvedValue(null);

    const res = await status("completed");

    expect(res.status).toBe(204);
    expect(db.updateCall).not.toHaveBeenCalled();
  });

  it("returns no TwiML body", async () => {
    expect(await (await status("completed")).text()).not.toContain("<Response>");
  });

  it("database error: 500 so Twilio retries", async () => {
    db.updateCall.mockRejectedValue(new Error("db down"));

    expect((await status("completed")).status).toBe(500);
  });

  it("rejects an invalid signature with 403 when mocks are off", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");

    const res = await status("completed");

    expect(res.status).toBe(403);
    expect(db.updateCall).not.toHaveBeenCalled();
  });
});
