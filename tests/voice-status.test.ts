import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BASE_URL, twilioRequest, callFixture } from "./helpers/voice";

const db = vi.hoisted(() => ({
  getCallBySid: vi.fn(),
  updateCall: vi.fn(),
  appendEvent: vi.fn(),
  getCallEvents: vi.fn(),
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
  db.appendEvent.mockResolvedValue({});
  db.getCallEvents.mockResolvedValue([]);
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

  describe("hang-up during the time-waster persona", () => {
    const START = "2026-12-01T10:00:00.000Z";
    const entry = {
      type: "state_change",
      payload: { type: "state_change", from: "screening", to: "time_wasted", started_at: START },
      created_at: START,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-12-01T10:00:03.000Z"));
      db.getCallBySid.mockResolvedValue(callFixture({ state: "time_wasted" }));
      db.getCallEvents.mockResolvedValue([entry]);
    });
    afterEach(() => vi.useRealTimers());

    it("writes the exit event once and sets outcome time_wasted, not transferred", async () => {
      const res = await status("completed");

      expect(res.status).toBe(204);
      expect(db.appendEvent).toHaveBeenCalledTimes(1);
      expect(db.appendEvent).toHaveBeenCalledWith({
        call_id: callFixture().id,
        type: "state_change",
        payload: {
          type: "state_change",
          from: "time_wasted",
          to: "completed",
          started_at: START,
          ended_at: "2026-12-01T10:00:03.000Z",
          seconds: 3,
          reason: "caller_hung_up",
        },
      });
      expect(db.updateCall).toHaveBeenCalledWith(
        "CA_TEST_0001",
        expect.objectContaining({ state: "completed", outcome: "time_wasted" }),
      );
    });

    it("does not write a second exit event when one already exists (retry)", async () => {
      db.getCallEvents.mockResolvedValue([
        entry,
        {
          type: "state_change",
          payload: { type: "state_change", from: "time_wasted", to: "completed", ended_at: "2026-12-01T10:00:02.000Z" },
          created_at: "2026-12-01T10:00:02.000Z",
        },
      ]);

      await status("completed");

      expect(db.appendEvent).not.toHaveBeenCalled();
    });

    it("a call that was not in time_wasted writes no exit event", async () => {
      db.getCallBySid.mockResolvedValue(callFixture({ state: "screening" }));

      await status("completed");

      expect(db.appendEvent).not.toHaveBeenCalled();
      expect(db.updateCall).toHaveBeenCalledWith(
        "CA_TEST_0001",
        expect.objectContaining({ outcome: "transferred" }),
      );
    });
  });

  describe("events", () => {
    it("hang-up at 3 s writes one exit event with reason caller_hung_up and seconds 3, outcome time_wasted", async () => {
      const START = "2026-12-01T10:00:00.000Z";
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-12-01T10:00:03.000Z"));
      try {
        db.getCallBySid.mockResolvedValue(callFixture({ state: "time_wasted" }));
        db.getCallEvents.mockResolvedValue([
          {
            type: "state_change",
            payload: { type: "state_change", from: "screening", to: "time_wasted", started_at: START },
            created_at: START,
          },
        ]);

        await status("completed");

        expect(db.appendEvent).toHaveBeenCalledTimes(1);
        expect(db.appendEvent.mock.calls[0]![0].payload).toMatchObject({
          from: "time_wasted",
          to: "completed",
          started_at: START,
          ended_at: "2026-12-01T10:00:03.000Z",
          seconds: 3,
          reason: "caller_hung_up",
        });
        expect(db.updateCall).toHaveBeenCalledWith(
          "CA_TEST_0001",
          expect.objectContaining({ outcome: "time_wasted" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
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
