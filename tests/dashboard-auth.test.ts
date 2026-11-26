import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { NextRequest } from "next/server";
import {
  DASHBOARD_COOKIE,
  deriveToken,
  isValidToken,
  safeNextPath,
  verifyPasscode,
} from "@/lib/dashboard-auth";
import { proxy, config } from "@/proxy";
import { POST as unlock } from "@/app/api/unlock/route";

const ORIGINAL = process.env.DASHBOARD_PASSCODE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DASHBOARD_PASSCODE;
  else process.env.DASHBOARD_PASSCODE = ORIGINAL;
});

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie: `${DASHBOARD_COOKIE}=${cookie}` } : {},
  });

describe("cookie derivation and check", () => {
  it("never contains the passcode and validates only for the same passcode", () => {
    const token = deriveToken("open-sesame");
    expect(token).not.toContain("open-sesame");
    expect(isValidToken(token, "open-sesame")).toBe(true);
    expect(isValidToken(token, "other")).toBe(false);
    expect(isValidToken("", "open-sesame")).toBe(false);
    expect(isValidToken(token, null)).toBe(false);
  });

  it("property: a token is valid for its own passcode only", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        expect(isValidToken(deriveToken(a), a)).toBe(true);
        if (a !== b) expect(isValidToken(deriveToken(a), b)).toBe(false);
        expect(verifyPasscode(a, a)).toBe(true);
        if (a !== b) expect(verifyPasscode(b, a)).toBe(false);
      }),
    );
  });
});

describe("safeNextPath", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNextPath("/calls/abc?x=1")).toBe("/calls/abc?x=1");
  });
  it.each(["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "/a\nb", "", undefined, "/unlock"])(
    "rejects %s",
    (v) => {
      expect(safeNextPath(v)).toBe("/live");
    },
  );
});

describe("proxy", () => {
  it("redirects a request without the cookie to /unlock with the return path", async () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    const res = proxy(req("/calls/123?a=b"));
    const loc = new URL(res.headers.get("location")!);
    expect(res.status).toBe(307);
    expect(loc.pathname).toBe("/unlock");
    expect(loc.searchParams.get("next")).toBe("/calls/123?a=b");
  });

  it("lets a request with a valid cookie through", () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    const res = proxy(req("/live", deriveToken("secret")));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects a cookie derived from another passcode", () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    expect(proxy(req("/live", deriveToken("wrong"))).status).toBe(307);
  });

  it("returns 401 JSON for /api/live without the cookie", () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    expect(proxy(req("/api/live?callId=1")).status).toBe(401);
  });

  it("fails closed when DASHBOARD_PASSCODE is unset, even with a cookie", () => {
    delete process.env.DASHBOARD_PASSCODE;
    expect(proxy(req("/live", deriveToken(""))).status).toBe(307);
    expect(proxy(req("/api/live")).status).toBe(503);
  });

  it("matcher leaves webhooks, dev tools and the unlock routes outside", () => {
    const re = new RegExp(`^${config.matcher[0]}$`);
    for (const p of ["/api/voice/incoming", "/api/sms/in", "/dev/phone", "/api/dev/phone/turn", "/unlock", "/api/unlock"]) {
      expect(re.test(p), p).toBe(false);
    }
    for (const p of ["/live", "/calls/1", "/reports/1", "/settings", "/api/live", "/api/settings/household"]) {
      expect(re.test(p), p).toBe(true);
    }
  });
});

describe("POST /api/unlock", () => {
  const post = (fields: Record<string, string>) => {
    const body = new URLSearchParams(fields);
    return unlock(
      new Request("http://localhost:3000/api/unlock", {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
  };

  it("sets an httpOnly cookie without the passcode and returns to the original page", async () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    const res = await post({ passcode: "secret", next: "/calls/42" });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/calls/42");
    const set = res.headers.get("set-cookie")!;
    expect(set).toContain(`${DASHBOARD_COOKIE}=${deriveToken("secret")}`);
    expect(set.toLowerCase()).toContain("httponly");
    expect(set).not.toContain("=secret;");
  });

  it("ignores an off-site return path", async () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    const res = await post({ passcode: "secret", next: "https://evil.com" });
    expect(new URL(res.headers.get("location")!).origin).toBe("http://localhost:3000");
  });

  it("refuses a wrong passcode and sets no cookie", async () => {
    process.env.DASHBOARD_PASSCODE = "secret";
    const res = await post({ passcode: "nope", next: "/live" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/unlock");
    expect(loc.searchParams.get("error")).toBe("wrong");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses everything when the passcode is unset", async () => {
    delete process.env.DASHBOARD_PASSCODE;
    const res = await post({ passcode: "", next: "/live" });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("unconfigured");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
