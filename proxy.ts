/**
 * Dashboard passcode gate (Next.js proxy, formerly middleware).
 *
 * Protected: dashboard pages, /calls/*, /reports/*, settings, /api/live,
 * /api/simulate and everything else not excluded below.
 * Not covered (excluded by the matcher):
 *   /api/voice/*, /api/sms/*  Twilio webhooks, validated by X-Twilio-Signature
 *   /dev/*, /api/dev/*        governed by their own dev-tools gate
 *   /unlock, /api/unlock      the passcode page and its submit route
 *   _next assets, favicon
 * Fails closed: with DASHBOARD_PASSCODE unset nothing is let through.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  DASHBOARD_COOKIE,
  UNLOCK_PATH,
  configuredPasscode,
  isValidToken,
} from "@/lib/dashboard-auth";

export function proxy(request: NextRequest) {
  const passcode = configuredPasscode();
  const { pathname, search } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (!passcode) {
    if (isApi) {
      return NextResponse.json({ error: "Dashboard passcode is not configured" }, { status: 503 });
    }
    const url = request.nextUrl.clone();
    url.pathname = UNLOCK_PATH;
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (isValidToken(request.cookies.get(DASHBOARD_COOKIE)?.value, passcode)) {
    return NextResponse.next();
  }

  if (isApi) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = UNLOCK_PATH;
  url.search = "";
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api/voice|api/sms|api/dev|api/unlock|dev|unlock|_next/static|_next/image|favicon\\.ico).*)",
  ],
};
