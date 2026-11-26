/**
 * GET /api/calls?before=<ISO started_at>
 *
 * Passcode-checked by proxy.ts. Returns the next 25 calls older than the
 * cursor for "Load more". Logic lives in lib/calls-list.ts.
 */

import { loadCallsPage, parseCursor } from "@/lib/calls-list";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get("before");
  const before = parseCursor(raw);
  if (raw !== null && before === null) {
    return Response.json({ error: "Invalid cursor" }, { status: 400 });
  }
  try {
    const page = await loadCallsPage(before);
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[api/calls] error:", err instanceof Error ? err.message : "unknown");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
