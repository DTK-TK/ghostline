import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BASE_URL, twilioRequest, parseTwiml, householdFixture, callFixture } from "./helpers/voice";

const db = vi.hoisted(() => ({
  getCallBySid: vi.fn(),
  getHousehold: vi.fn(),
  updateCall: vi.fn(),
  appendEvent: vi.fn(),
}));
const engine = vi.hoisted(() => ({ runTurn: vi.fn() }));
vi.mock("@/lib/db", () => db);
vi.mock("@/lib/conversation-engine", () => engine);

import { POST } from "@/app/api/voice/turn/route";

const SPEECH = { CallSid: "CA_TEST_0001", From: "+15550009999", To: "+15550000000", SpeechResult: "Hi, I am calling about my appointment", Digits: "" };

function turn(params: Record<string, string> = SPEECH) {
  return POST(twilioRequest("/api/voice/turn", params));
}

function engineReturns(nextState: string, level = "low", score = 0, reply = "Thank you. Could you tell me more?") {
  engine.runTurn.mockResolvedValue({ reply, nextState, riskUpdate: { score, level } });
}

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", BASE_URL);
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+15550001111");
  db.getCallBySid.mockResolvedValue(callFixture());
  db.getHousehold.mockResolvedValue(householdFixture());
  db.updateCall.mockResolvedValue({});
  db.appendEvent.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/voice/turn: nextState to TwiML", () => {
  it("screening: speaks the reply, gathers speech, redirects back to /turn", async () => {
    engineReturns("screening", "low", 0, "Could you tell me more?");

    const res = await turn();
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(xml).toContain('input="speech"');
    expect(xml).toContain(`action="${BASE_URL}/api/voice/turn"`);
    expect(xml).toContain("Could you tell me more?");
  });

  it("initiated: keeps gathering, same as screening", async () => {
    db.getCallBySid.mockResolvedValue(callFixture({ state: "initiated" }));
    engineReturns("initiated");

    expect(parseTwiml(await (await turn()).text())).toEqual(["Gather", "Say", "Redirect"]);
  });

  it("time_wasted: keeps gathering with the grandmother line", async () => {
    engineReturns("time_wasted", "high", 80, "Oh dear, where are my glasses?");

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(xml).toContain("Oh dear, where are my glasses?");
  });

  it("verified: dials the senior", async () => {
    engineReturns("verified");

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Dial", "Number"]);
    expect(xml).toContain('callerId="+15550001111"');
    expect(xml).toContain("+15550000000</Number>");
  });

  it("transferring: dials the senior", async () => {
    engineReturns("transferring");

    expect(parseTwiml(await (await turn()).text())).toEqual(["Dial", "Number"]);
  });

  it("scam_blocked: says the refusal line and hangs up without accusing", async () => {
    engineReturns("scam_blocked", "high", 90);

    const xml = await (await turn()).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Hangup"]);
    expect(xml).toContain("I'm not able to connect this call.");
    expect(xml.toLowerCase()).not.toContain("scam");
  });

  it("completed: says unable-to-connect and records a message", async () => {
    engineReturns("completed");

    expect(parseTwiml(await (await turn()).text())).toEqual(["Say", "Record"]);
  });
});

describe("POST /api/voice/turn: persistence", () => {
  it("stores the caller's speech as a transcript event", async () => {
    engineReturns("screening");

    await turn();

    expect(db.appendEvent).toHaveBeenCalledWith({
      call_id: callFixture().id,
      type: "transcript",
      payload: { type: "transcript", text: SPEECH.SpeechResult, speaker: "caller" },
    });
  });

  it("appends a state_change event only when the state changes", async () => {
    engineReturns("screening");
    await turn();
    expect(db.appendEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "state_change" }));

    db.appendEvent.mockClear();
    engineReturns("scam_blocked", "high", 90);
    await turn();
    expect(db.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state_change",
        payload: { type: "state_change", from: "screening", to: "scam_blocked" },
      }),
    );
  });

  it("never lowers the stored risk score", async () => {
    db.getCallBySid.mockResolvedValue(callFixture({ risk_score: 60 }));
    engineReturns("screening", "low", 10);

    await turn();

    expect(db.updateCall).toHaveBeenCalledWith(
      "CA_TEST_0001",
      expect.objectContaining({ risk_score: 60 }),
    );
  });
});

describe("POST /api/voice/turn: silence", () => {
  it("empty speech while screening: says goodbye, records, and marks the call dropped", async () => {
    const res = await turn({ ...SPEECH, SpeechResult: "" });
    const xml = await res.text();

    expect(parseTwiml(xml)).toEqual(["Say", "Record"]);
    expect(engine.runTurn).not.toHaveBeenCalled();
    expect(db.updateCall).toHaveBeenCalledWith("CA_TEST_0001", { state: "completed", outcome: "dropped" });
  });

  it("still stores the empty turn as a transcript event", async () => {
    await turn({ ...SPEECH, SpeechResult: "" });

    expect(db.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "transcript", payload: expect.objectContaining({ text: "" }) }),
    );
  });
});

describe("POST /api/voice/turn: failures", () => {
  it("unknown CallSid: Say + Record fallback", async () => {
    db.getCallBySid.mockResolvedValue(null);

    expect(parseTwiml(await (await turn()).text())).toEqual(["Say", "Record"]);
    expect(engine.runTurn).not.toHaveBeenCalled();
  });

  it("engine error: Say + Record fallback, not a 500", async () => {
    engine.runTurn.mockRejectedValue(new Error("boom"));

    const res = await turn();

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Say", "Record"]);
  });

  it("rejects an invalid signature with 403 when mocks are off", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");

    const res = await turn();

    expect(res.status).toBe(403);
    expect(db.getCallBySid).not.toHaveBeenCalled();
  });
});
