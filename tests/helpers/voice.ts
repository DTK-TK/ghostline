/**
 * Shared helpers for the /api/voice/* route tests.
 * Not picked up by vitest (the include pattern only matches *.test.ts).
 */

export const BASE_URL = "https://ghostline.test";

/** Build a Request shaped like Twilio's webhook POST (form-encoded body). */
export function twilioRequest(
  path: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

/**
 * Assert the string is well-formed TwiML: XML declaration, a single
 * <Response> root, and properly nested tags. Returns the verbs found
 * directly or nested inside <Response>, in document order.
 */
export function parseTwiml(xml: string): string[] {
  if (!xml.startsWith("<?xml")) throw new Error("Missing XML declaration");

  const body = xml.replace(/^<\?xml[^?]*\?>/, "");
  const tagRe = /<(\/?)([A-Za-z]+)((?:\s+[A-Za-z]+="[^"]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  const verbs: string[] = [];
  let rootClosed = false;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(body)) !== null) {
    const [, closing, name, , selfClosing] = match;
    if (rootClosed) throw new Error("Content after </Response>");

    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`Mismatched tag: expected </${open}>, got </${name}>`);
      if (stack.length === 0) rootClosed = true;
      continue;
    }

    if (stack.length === 0 && name !== "Response") {
      throw new Error(`Root element must be <Response>, got <${name}>`);
    }
    if (name !== "Response") verbs.push(name!);
    if (!selfClosing) stack.push(name!);
    else if (stack.length === 0) throw new Error("Root cannot be self-closing");
  }

  if (stack.length !== 0) throw new Error(`Unclosed tag: <${stack[stack.length - 1]}>`);
  if (!rootClosed) throw new Error("No <Response> root found");
  return verbs;
}

export function householdFixture() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    family_name: "Sun",
    senior_phone: "+15550000000",
    safe_word_hash: "$2b$12$placeholderplaceholderplaceholderplaceholderplaceho",
    time_waster_enabled: true,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

export function callFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    household_id: householdFixture().id,
    call_sid: "CA_TEST_0001",
    from_number: "+15550009999",
    claimed_identity: null,
    state: "screening",
    risk_score: 0,
    risk_level: "low",
    outcome: null,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    summary: null,
    ...overrides,
  };
}
