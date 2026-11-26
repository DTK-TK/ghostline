import type { Metadata } from "next";
import { loadCallsPage } from "@/lib/calls-list";
import { CallsTable } from "./calls-table";

export const metadata: Metadata = { title: "Calls | Ghostline" };
export const dynamic = "force-dynamic";

export default async function CallsPage() {
  // Serves the demo household (is_demo), else the oldest household.
  const initial = await loadCallsPage();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Calls</h1>
      <CallsTable initial={initial} />
    </div>
  );
}
