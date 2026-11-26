import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseCallId } from "@/lib/call-id";
import { getLivePayload } from "@/lib/live-poll";
import { CallDetails } from "./call-details";

export const metadata: Metadata = { title: "Call details | Ghostline" };
export const dynamic = "force-dynamic";

export default async function CallDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = parseCallId(raw);
  if (!id) notFound();

  // Loads with the service role through lib/db.ts. Numbers and safe word
  // attempts are already masked/stripped by getLivePayload.
  const result = await getLivePayload(id);
  if (result.status === 400 || result.status === 404) notFound();
  if (result.status !== 200) throw new Error("Could not load the call");

  // "Viewed" is a no-op for now: the unread dot is deferred (task 13).
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Call details</h1>
      <CallDetails callId={id} initial={result.body} />
    </div>
  );
}
