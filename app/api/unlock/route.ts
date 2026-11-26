/**
 * POST /api/unlock  (form: passcode, next)
 * Checks the passcode, sets the httpOnly cookie, redirects to the page the
 * visitor came from. Wrong passcode: back to /unlock with an error flag.
 * Never logs the passcode.
 */
import { NextResponse } from "next/server";
import {
  DASHBOARD_COOKIE,
  DASHBOARD_COOKIE_MAX_AGE,
  UNLOCK_PATH,
  configuredPasscode,
  deriveToken,
  safeNextPath,
  verifyPasscode,
} from "@/lib/dashboard-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const submitted = form?.get("passcode");
  const next = safeNextPath(form?.get("next"));
  const passcode = configuredPasscode();

  const back = (error: string) => {
    const url = new URL(UNLOCK_PATH, request.url);
    url.searchParams.set("error", error);
    if (next !== "/live") url.searchParams.set("next", next);
    return NextResponse.redirect(url, 303);
  };

  if (!passcode) return back("unconfigured");
  if (!verifyPasscode(submitted, passcode)) return back("wrong");

  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(DASHBOARD_COOKIE, deriveToken(passcode), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DASHBOARD_COOKIE_MAX_AGE,
  });
  return response;
}
