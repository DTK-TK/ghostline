/**
 * lib/twilio-validate.ts
 *
 * Validates that an incoming request genuinely originated from Twilio.
 *
 * How it works
 * ─────────────
 * Twilio signs every webhook POST with HMAC-SHA1 over (URL + sorted params).
 * The signature arrives in the X-Twilio-Signature header.
 * validateRequest() (from the twilio npm package) replicates the HMAC and
 * compares with a timing-safe byte comparison.
 *
 * Next.js App Router gives us a web-standard Request, so we:
 *   1. Clone the request and read the body as text (once — bodies are
 *      single-read streams).
 *   2. Parse the application/x-www-form-urlencoded body into a plain object.
 *   3. Pass (authToken, signature, fullUrl, params) to validateRequest().
 *
 * PUBLIC_BASE_URL must be the exact public-facing URL Twilio will call,
 * including scheme and host (e.g. https://ghostline.example.com).  It must
 * NOT have a trailing slash.
 */

import { validateRequest } from "twilio";

/** Thrown when a request fails signature validation. */
export class TwilioSignatureError extends Error {
  readonly status = 403;
  constructor() {
    super("Invalid Twilio signature");
    this.name = "TwilioSignatureError";
  }
}

/**
 * Parse application/x-www-form-urlencoded text into a plain string→string
 * object that validateRequest() expects.
 */
export function parseFormBody(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!text) return params;
  for (const pair of text.split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
    const val = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
    params[key] = val;
  }
  return params;
}

/**
 * Validate the Twilio webhook signature on a Next.js App Router Request.
 *
 * Returns the parsed form body (already read from the stream) so the caller
 * does not need to read it again.
 *
 * Throws TwilioSignatureError if the signature is absent or invalid.
 * Throws Error if required env vars are missing.
 */
export async function validateTwilioRequest(
  req: Request,
): Promise<Record<string, string>> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl = process.env.PUBLIC_BASE_URL;

  if (!authToken) throw new Error("Missing TWILIO_AUTH_TOKEN");
  if (!baseUrl) throw new Error("Missing PUBLIC_BASE_URL");

  const signature = req.headers.get("x-twilio-signature") ?? "";

  // Reconstruct the exact URL Twilio signed — path + query, no trailing slash.
  const reqUrl = new URL(req.url);
  const fullUrl = `${baseUrl}${reqUrl.pathname}${reqUrl.search}`;

  // Read and parse body (stream can only be consumed once).
  const bodyText = await req.text();
  const params = parseFormBody(bodyText);

  const valid = validateRequest(authToken, signature, fullUrl, params);
  if (!valid) throw new TwilioSignatureError();

  return params;
}

/** Convenience: build a TwiML Response with the correct Content-Type header. */
export function twimlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
