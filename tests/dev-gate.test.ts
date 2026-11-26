import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/db", () => ({
  getCallEvents: vi.fn(),
  getCallBySid: vi.fn(),
  getHouseholdByPhone: vi.fn(),
  isTrustedContact: vi.fn(),
  createCall: vi.fn(),
  adminDb: vi.fn(() => {
    throw new Error("db must not be touched when the gate is closed");
  }),
}));
vi.mock("@/lib/turn", () => ({ processTurn: vi.fn() }));
vi.mock("@/lib/time-waster", () => ({ timeWastedView: vi.fn() }));
vi.mock("@/lib/callback", () => ({ recordCallbackResult: vi.fn() }));

import { devToolsEnabled } from "@/lib/dev-gate";
import { POST as startPOST } from "@/app/api/dev/phone/start/route";
import { POST as turnPOST } from "@/app/api/dev/phone/turn/route";
import { POST as answerPOST } from "@/app/api/dev/phone/callback-answer/route";
import { GET as inboxGET } from "@/app/api/dev/phone/inbox/route";
import { getCallBySid, createCall } from "@/lib/db";
import { processTurn } from "@/lib/turn";
import { recordCallbackResult } from "@/lib/callback";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("devToolsEnabled()", () => {
  it("is false in production, even with ENABLE_DEV_TOOLS=true", () => {
    expect(devToolsEnabled({ VERCEL_ENV: "production", ENABLE_DEV_TOOLS: "true", NODE_ENV: "production" })).toBe(false);
    expect(devToolsEnabled({ VERCEL_ENV: "production", NODE_ENV: "development" })).toBe(false);
  });

  it("is false on preview without the flag (NODE_ENV=production)", () => {
    expect(devToolsEnabled({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(false);
  });

  it("is true on preview with ENABLE_DEV_TOOLS=true", () => {
    expect(devToolsEnabled({ VERCEL_ENV: "preview", NODE_ENV: "production", ENABLE_DEV_TOOLS: "true" })).toBe(true);
  });

  it("is true in development", () => {
    expect(devToolsEnabled({ VERCEL_ENV: "development", NODE_ENV: "development" })).toBe(true);
    expect(devToolsEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  it("is false with NODE_ENV=production, no VERCEL_ENV, no flag", () => {
    expect(devToolsEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("only the exact string 'true' enables the flag", () => {
    expect(devToolsEnabled({ VERCEL_ENV: "preview", NODE_ENV: "production", ENABLE_DEV_TOOLS: "1" })).toBe(false);
  });

  it("property: matches the rule for every env combination", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, "", "production", "preview", "development"),
        fc.constantFrom(undefined, "", "true", "false", "1"),
        fc.constantFrom(undefined, "production", "development", "test"),
        (vercel, flag, node) => {
          const expected =
            vercel !== "production" && (flag === "true" || node === "development");
          expect(devToolsEnabled({ VERCEL_ENV: vercel, ENABLE_DEV_TOOLS: flag, NODE_ENV: node })).toBe(expected);
        },
      ),
    );
  });
});

function post(path: string, body: unknown = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routes: Array<[string, () => Promise<Response>]> = [
  ["start", () => startPOST(post("/api/dev/phone/start", { fromNumber: "+15550009999", householdPhone: "+15550000000" }))],
  ["turn", () => turnPOST(post("/api/dev/phone/turn", { callSid: "DEV_1", speechResult: "hi" }))],
  ["callback-answer", () => answerPOST(post("/api/dev/phone/callback-answer", { callSid: "DEV_1", digit: "1" }))],
  ["inbox", () => inboxGET(new Request("http://localhost/api/dev/phone/inbox"))],
];

describe("/api/dev/phone/* gate", () => {
  for (const [name, call] of routes) {
    it(`${name}: 404 in production`, async () => {
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("ENABLE_DEV_TOOLS", "true");
      const res = await call();
      expect(res.status).toBe(404);
    });

    it(`${name}: 404 on preview without ENABLE_DEV_TOOLS`, async () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_DEV_TOOLS", "");
      const res = await call();
      expect(res.status).toBe(404);
    });
  }

  it("no handler reaches its dependencies when the gate is closed", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("ENABLE_DEV_TOOLS", "");
    expect(vi.mocked(createCall)).not.toHaveBeenCalled();
    expect(vi.mocked(getCallBySid)).not.toHaveBeenCalled();
    expect(vi.mocked(processTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(recordCallbackResult)).not.toHaveBeenCalled();
  });
});
