import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import twilio from "twilio";
import { BASE_URL, twilioRequest, parseTwiml, householdFixture } from "./helpers/voice";

const db = vi.hoisted(() => ({
  getHouseholdByPhone: vi.fn(),
  isTrustedContact: vi.fn(),
  createCall: vi.fn(),
}));
vi.mock("@/lib/db", () => db);

import { POST } from "@/app/api/voice/incoming/route";

const FORM = { CallSid: "CA_TEST_0001", From: "+15550009999", To: "+15550000000" };

beforeEach(() => {
  vi.stubEnv("MOCK_TELEPHONY", "true");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("PUBLIC_BASE_URL", BASE_URL);
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+15550001111");
  db.getHouseholdByPhone.mockResolvedValue(householdFixture());
  db.isTrustedContact.mockResolvedValue(false);
  db.createCall.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("POST /api/voice/incoming", () => {
  it("unknown caller: speaks the opening line, gathers speech, redirects to /turn", async () => {
    const res = await POST(twilioRequest("/api/voice/incoming", FORM));
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(parseTwiml(xml)).toEqual(["Gather", "Say", "Redirect"]);
    expect(xml).toContain('input="speech"');
    expect(xml).toContain(`action="${BASE_URL}/api/voice/turn"`);
    expect(xml).toContain(
      "You've reached the Sun residence. This call is screened by Ghostline. " +
        "Please say your name and why you're calling.",
    );
    expect(db.createCall).toHaveBeenCalledWith(
      expect.objectContaining({ call_sid: "CA_TEST_0001", from_number: "+15550009999", state: "screening" }),
    );
  });

  it("trusted contact: dials the senior with the Ghostline number as caller ID, no screening", async () => {
    db.isTrustedContact.mockResolvedValue(true);

    const res = await POST(twilioRequest("/api/voice/incoming", FORM));
    const xml = await res.text();

    expect(parseTwiml(xml)).toEqual(["Dial", "Number"]);
    expect(xml).toContain('callerId="+15550001111"');
    expect(xml).toContain("+15550000000</Number>");
    expect(xml).not.toContain("Gather");
    expect(db.createCall).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed", outcome: "transferred" }),
    );
  });

  it("unknown household: falls back to Say + Record", async () => {
    db.getHouseholdByPhone.mockResolvedValue(null);

    const xml = await (await POST(twilioRequest("/api/voice/incoming", FORM))).text();

    expect(parseTwiml(xml)).toEqual(["Say", "Record"]);
    expect(db.createCall).not.toHaveBeenCalled();
  });

  it("database error: falls back to Say + Record instead of dead air", async () => {
    db.getHouseholdByPhone.mockRejectedValue(new Error("db down"));

    const res = await POST(twilioRequest("/api/voice/incoming", FORM));

    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toEqual(["Say", "Record"]);
  });
});

describe("signature validation on /api/voice/incoming", () => {
  beforeEach(() => {
    vi.stubEnv("MOCK_TELEPHONY", "false");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  });

  it("rejects a missing signature with 403 and no TwiML", async () => {
    const res = await POST(twilioRequest("/api/voice/incoming", FORM));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("<Response>");
    expect(db.createCall).not.toHaveBeenCalled();
  });

  it("rejects a wrong signature with 403", async () => {
    const res = await POST(
      twilioRequest("/api/voice/incoming", FORM, { "X-Twilio-Signature": "bogus" }),
    );
    expect(res.status).toBe(403);
  });

  it("accepts a correct signature", async () => {
    const signature = twilio.getExpectedTwilioSignature(
      "test-auth-token",
      `${BASE_URL}/api/voice/incoming`,
      FORM,
    );
    const res = await POST(
      twilioRequest("/api/voice/incoming", FORM, { "X-Twilio-Signature": signature }),
    );
    expect(res.status).toBe(200);
    expect(parseTwiml(await res.text())).toContain("Gather");
  });

  it("never skips validation in production, even with MOCK_TELEPHONY=true", async () => {
    vi.stubEnv("MOCK_TELEPHONY", "true");
    vi.stubEnv("VERCEL_ENV", "production");

    const res = await POST(twilioRequest("/api/voice/incoming", FORM));
    expect(res.status).toBe(403);
  });
});
