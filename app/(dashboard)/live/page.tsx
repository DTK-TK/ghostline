import type { Metadata } from "next";
import { simulatorEnabled } from "@/lib/simulator/handlers";
import { listScenarios } from "@/lib/simulator/scenarios";
import { LiveCall } from "./live-call";

export const metadata: Metadata = { title: "Live | Ghostline" };
// ENABLE_SIMULATOR is read per request, not baked in at build time.
export const dynamic = "force-dynamic";

export default function LivePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Live call</h1>
      <LiveCall simulator={simulatorEnabled() ? { scenarios: listScenarios() } : null} />
    </div>
  );
}
