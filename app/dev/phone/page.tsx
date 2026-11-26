/**
 * app/dev/phone/page.tsx
 *
 * Dev-only server wrapper. Returns 404 in production.
 * Renders the browser phone client component.
 */

import { notFound } from "next/navigation";
import PhoneClient from "./phone-client";
import { devToolsEnabled } from "@/lib/dev-gate";
import { adminDb } from "@/lib/db";
import { HouseholdSchema } from "@/lib/db";

export default async function DevPhonePage() {
  if (!devToolsEnabled()) notFound();

  // Load households so the user can pick one from a dropdown.
  const { data, error } = await adminDb()
    .from("households")
    .select("id, family_name, senior_phone")
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    return (
      <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center font-mono">
        <p className="text-red-400">Database error: {error.message}</p>
      </main>
    );
  }

  const households = (data ?? []).map((row) =>
    HouseholdSchema.pick({ id: true, family_name: true, senior_phone: true }).parse(row),
  );

  return <PhoneClient households={households} />;
}
