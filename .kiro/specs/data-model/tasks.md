# Tasks – data-model

Re-planned for the hackathon MVP due Dec 4, 2026. Every task is kept. Decisions are in design.md under "Re-plan decisions".

---

## MVP (build now)

Reason: Everything the Dec 4, 2026 demo needs: a real call through the real engine, safe word and callback checks, the alert and fraud report, and the dashboard to watch it.

- [x] **1.** Write `supabase/migrations/0001_initial_schema.sql`
  - All six tables with correct columns, types, constraints, and indexes
  - `REPLICA IDENTITY FULL` on `calls` and `call_events`
  - `ALTER PUBLICATION supabase_realtime ADD TABLE` for both tables
  - `pgcrypto` extension
  - _MVP, done: Already built._

- [x] **2.** Write `supabase/seeds/demo.sql`
  - Household: family name Sun, senior phone placeholder
  - Safe word "pumpkin" hashed with `crypt(word, gen_salt('bf', 12))`
  - Two family members read from `current_setting()` / env vars
  - One trusted contact read from `current_setting()` / env vars
  - _MVP, done: Already built._

- [x] **3.** Write `lib/db.ts`
  - `Database` interface (manual, superseded when `supabase gen types` runs)
  - Zod schemas + TypeScript row/insert types for all six tables
  - `CallStateSchema`, `RiskLevelSchema`, `CallOutcomeSchema`, `CallEventTypeSchema` enums
  - `CallEventPayloadSchema` discriminated union for per-type payload validation
  - `createAdminClient()`, `createBrowserClient()`, `adminDb()` singleton
  - Helpers: `getHouseholdByPhone`, `getHousehold`
  - Helpers: `getContactsForHousehold`, `isTrustedContact`
  - Helpers: `getFamilyMembers`, `getAlertRecipients`, `getCallbackTargets`
  - Helpers: `createCall`, `getCallBySid`, `updateCall`, `updateCallState`, `getRecentCalls`
  - Helpers: `appendEvent`, `getCallEvents`
  - Helpers: `createFraudReport`, `getFraudReport`
  - _MVP, done: Already built._

- [x] **5.** Add RLS policies (separate migration) once auth is wired up.
  - _MVP, build item 4: RLS must be on before the app is reachable on the internet._
  - _Re-plan: Decision: enable RLS on every table with NO policies, in migration 0004 (see dashboard-and-simulator task 2). The browser reads nothing directly; the server uses the service role. Policies wait for Supabase Auth._

---

## Deferred (post-hackathon)

Reason: Not needed to show the demo (the demo household is seeded with SQL), so these wait until after the hackathon.

- [ ] **4.** Run `supabase gen types typescript --local > lib/database.types.ts` after first
  `supabase db push` and replace the hand-written `Database` interface in `lib/db.ts`
  with an import from that file.
  - _Deferred: The hand-written Database types work; generated types are a cleanup._
