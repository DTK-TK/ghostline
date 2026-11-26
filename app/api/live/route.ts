/**
 * GET /api/live?callId=<uuid>
 *
 * Passcode-checked by proxy.ts. Omit callId to get the active call (newest
 * call with no ended_at that started in the last 15 minutes), or
 * { call: null } when there is none. Logic lives in lib/live-poll.ts.
 */

import { getLivePayload } from "@/lib/live-poll";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const callId = new URL(req.url).searchParams.get("callId");
  const result = await getLivePayload(callId);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
