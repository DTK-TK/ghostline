/**
 * GET /api/dev/phone/inbox
 *
 * Dev-only. Returns all rows from mock_messages, newest first.
 * Used by the Mock Inbox panel in /dev/phone.
 *
 * Returns 404 unless devToolsEnabled() (lib/dev-gate.ts).
 *
 * Response: { messages: MockMessageRow[] }
 */

import { devToolsEnabled, devToolsNotFound } from "@/lib/dev-gate";
import { adminDb } from "@/lib/db";
import { maskPhone, maskPhonesInText } from "@/lib/phone";
import { z } from "zod";

export const runtime = "nodejs";

const MockMessageSchema = z.object({
  id: z.string(),
  to_number: z.string(),
  body: z.string(),
  kind: z.enum(["sms", "callback_call"]),
  created_at: z.string(),
});

export type MockMessageRow = z.infer<typeof MockMessageSchema>;

export async function GET(req: Request): Promise<Response> {
  if (!devToolsEnabled()) return devToolsNotFound();

  // Allow optional ?since=ISO8601 to poll for new messages only.
  const url = new URL(req.url);
  const since = url.searchParams.get("since");

  try {
    let query = adminDb()
      .from("mock_messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (since) {
      query = query.gt("created_at", since);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Masked numbers only: the full number never leaves the server.
    const messages = (data ?? []).map((row) => {
      const m = MockMessageSchema.parse(row);
      return { ...m, to_number: maskPhone(m.to_number), body: maskPhonesInText(m.body) };
    });
    return Response.json({ messages });
  } catch (err) {
    console.error("[dev/phone/inbox] error:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
