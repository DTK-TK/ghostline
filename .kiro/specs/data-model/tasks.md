# Tasks – data-model

- [x] Write `supabase/migrations/0001_initial_schema.sql`
  - All six tables with correct columns, types, constraints, and indexes
  - `REPLICA IDENTITY FULL` on `calls` and `call_events`
  - `ALTER PUBLICATION supabase_realtime ADD TABLE` for both tables
  - `pgcrypto` extension

- [x] Write `supabase/seeds/demo.sql`
  - Household: family name Sun, senior phone placeholder
  - Safe word "pumpkin" hashed with `crypt(word, gen_salt('bf', 12))`
  - Two family members read from `current_setting()` / env vars
  - One trusted contact read from `current_setting()` / env vars

- [x] Write `lib/db.ts`
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

- [ ] Run `supabase gen types typescript --local > lib/database.types.ts` after first
  `supabase db push` and replace the hand-written `Database` interface in `lib/db.ts`
  with an import from that file.

- [ ] Add RLS policies (separate migration) once auth is wired up.
