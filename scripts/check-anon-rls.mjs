// Verifies the anon key can read no rows and write nothing, on every table.
// Usage: node --env-file=.env.local scripts/check-anon-rls.mjs
// Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY (the last only to confirm the tables have data).
// Prints counts only; never prints keys or row contents.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(2);
}

const tables = ["households", "contacts", "family_members", "calls", "call_events", "fraud_reports", "mock_messages"];
const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const admin = serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null;

let failed = false;
for (const t of tables) {
  const { data, error } = await anon.from(t).select("*").limit(5);
  const rows = data?.length ?? 0;
  let total = "n/a";
  if (admin) {
    const { count } = await admin.from(t).select("*", { count: "exact", head: true });
    total = String(count ?? "?");
  }
  const ok = rows === 0;
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${t}: anon read ${rows} rows (service role sees ${total})${error ? ` [${error.code}]` : ""}`);
}

// Writes must be refused too.
const { error: insertError } = await anon.from("mock_messages").insert({ to_number: "+10000000000", body: "x", kind: "sms" });
const writeOk = !!insertError;
if (!writeOk) failed = true;
console.log(`${writeOk ? "PASS" : "FAIL"} anon insert into mock_messages ${writeOk ? "refused" : "ACCEPTED"}`);

process.exit(failed ? 1 : 0);
