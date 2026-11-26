/**
 * POST /api/voice/callback: the prompt the family member hears
 * (safe-word-and-callback task 11).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import twilio from "twilio";
import { BASE_URL, twilioRequest, parseTwiml, householdFixture, callFixture } from "./helpers/voice";

const db = vi.hoisted(() => ({
  getCallBySid: vi.fn(),
  getHousehold: vi.fn(),
  getCallEvents: vi.fn(),
  getCallbackTargets: vi.fn(),
  appendEvent: vi.fn(),
  updateCall: vi.fn(),
}));
vi.mock("@/lib/db", () => db);

import { POST } from "@/app/api/voice/callback/route";

const ORIGINAL = "CA_TEST_0001";
const ANSWER = { CallSid: "CA_CALLBACK_LEG", From: "+15550001111", To: "+15550002222" };

function answer(query: Record<string, string> = { originalCallSid: ORIGINAL, claimedName: "Sam" }) {
  const qs = new URLSearchParams(query).toString();
  return POST(twilioRequest(`/api/voice/callback?${qs}`, ANSWER));
}

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", BASE_URL);
  db.getCallBySid.mockResolvedValue(callFixture());
  db.getHousehold.mockResolvedValue(householdFixture());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/voice/callback", () => {
  it("speaks the exact prompt inside a one-digit Gather that posts to callback-result", async () => {
    const res = await answer();
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Say", "Hangup"]);
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain(
      "This is Ghostline. Someone saying they are Sam is calling the Sun family right now. " +
        "Press 1 if you are safe and NOT calling. Press 2 if it really is you.",
    );
    expect(xml).toContain(
      `action="${BASE_URL}/api/voice/callback-result?originalCallSid=${ORIGINAL}&amp;claimedName=Sam"`,
    );
    expect(xml).toContain("We did not get a response. Goodbye.");
  });

  it("cleans a name with markup", async () => {
    const xml = await (await answer({ originalCallSid: ORIGINAL, claimedName: "Sam</Say><Dial>+1555</Dial>" })).text();

    parseTwiml(xml);
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("Someone saying they are Sam Say Dial Dial is calling");
  });

  it("cuts a name over 40 characters", async () => {
    const long = "A".repeat(100);
    const xml = await (await answer({ originalCallSid: ORIGINAL, claimedName: long })).text();

    expect(xml).toContain(`they are ${"A".repeat(40)} is calling`);
    expect(xml).not.toContain("A".repeat(41));
  });

  it("uses 'someone' when the name is missing", async () => {
    const xml = await (await answer({ originalCallSid: ORIGINAL })).text();

    expect(xml).toContain("Someone saying they are someone is calling");
  });

  it("an unknown call gets a plain hangup, never the prompt", async () => {
    db.getCallBySid.mockResolvedValue(null);

    const xml = await (await answer()).text();

    expect(parseTwiml(xml)).toEqual(["Hangup"]);
  });

  it("a database error returns a plain hangup", async () => {
    db.getCallBySid.mockRejectedValue(new Error("db down"));

    const res = await answer();

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Hangup"]);
  });

  it("rejects a missing or invalid signature with 403 when mocks are off", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");

    const res = await answer();

    expect(res.status).toBe(403);
    expect(db.getCallBySid).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed request when mocks are off", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
    const path = `/api/voice/callback?originalCallSid=${ORIGINAL}&claimedName=Sam`;
    const signature = twilio.getExpectedTwilioSignature("test-auth-token", `${BASE_URL}${path}`, ANSWER);

    const res = await POST(twilioRequest(path, ANSWER, { "X-Twilio-Signature": signature }));

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toContain("Gather");
  });
});
