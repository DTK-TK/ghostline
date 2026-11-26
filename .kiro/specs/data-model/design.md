# Design – data-model

## Re-plan decisions (hackathon MVP, due Dec 4, 2026)

- RLS is enabled on every table with NO policies. The browser reads nothing directly. The server uses the service role key. Migration 0004 (dashboard-and-simulator task 2) does this.
- Supabase Auth, anonymous sessions and per-user policies are deferred.
- The `supabase_realtime` publication and `REPLICA IDENTITY FULL` from 0001 stay in place but unused. Realtime is deferred, and with RLS on and no policies a browser subscriber would receive nothing anyway.
- The "Realtime" section below describes the deferred design.
- `lib/database.types.ts` generation is deferred.

## Architecture

All persistent state lives in a single Supabase Postgres database. There is
no in-memory or Redis state. This is required because Next.js API routes run
as stateless serverless functions — they do not share memory across
invocations — and the Twilio voice pipeline can reach any function instance
for a given call.

### Client split

| Context | Client | Key |
|---|---|---|
| API routes, server components | `adminDb()` singleton | `SUPABASE_SERVICE_ROLE_KEY` |
| Browser dashboard | `createBrowserClient()` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

The service role client bypasses RLS (not yet configured). The anon client
respects RLS policies that will be added in a later migration.

## Entity Relationship

```
households 1 ──< contacts
households 1 ──< family_members
households 1 ──< calls
calls      1 ──< call_events
calls      1 ──< fraud_reports
```

All child tables cascade delete from `households`.

## Table Decisions

### `households.safe_word_hash`

Stored as a bcrypt hash with cost 12 (`gen_salt('bf', 12)`). Verification at
call time: `crypt(attempt, safe_word_hash) = safe_word_hash` (pgcrypto
constant-time compare). The plaintext never leaves the user's input field.

### `calls.call_sid` — unique index

Twilio guarantees `CallSid` uniqueness globally. It is the primary lookup key
during an active call because API route handlers only receive `CallSid` from
Twilio webhooks, not Ghostline's internal UUID.

### `calls.state` — text, not enum

Postgres `ENUM` types are painful to extend (requires a migration with a
table rewrite in older Postgres versions). The allowed values are enforced at
the application layer by the `CallStateSchema` Zod enum.

### `call_events` — append-only

There are no `UPDATE` or `DELETE` helpers for `call_events`. The table is an
audit log. Each new fact gets its own row.

### `call_events.payload` — discriminated union

The JSONB payload for each event type is validated before insert by
`CallEventPayloadSchema` (a Zod discriminated union keyed on `type`). This
keeps the SQL schema flexible while enforcing structure at the TypeScript
layer.

### Realtime

`REPLICA IDENTITY FULL` is required for `UPDATE` and `DELETE` events to
carry the old row values to subscribers. The dashboard filters on
`household_id` client-side after receiving the broadcast.

## File Layout

```
supabase/
  migrations/
    0001_initial_schema.sql   -- DDL + Realtime setup
  seeds/
    demo.sql                  -- DO $$ block; reads env via current_setting()
lib/
  db.ts                       -- Zod schemas, TypeScript row types, helpers
```

## `lib/db.ts` Structure

```
Database interface          hand-written until `supabase gen types` runs
Zod schemas                 one per table (Row + Insert variants)
Type exports                z.infer<typeof Schema> for each
Client factories            createAdminClient(), createBrowserClient(), adminDb()
Helpers per table           thin wrappers that parse+validate every row
```

### Helper conventions

- Every helper throws on Supabase error (no silent `null` on error).
- Every returned row is parsed through its Zod schema, catching schema drift
  between DB and code early.
- Insert helpers validate input before sending it to Supabase.
- `appendEvent` validates both the outer `CallEventInsert` schema and the
  per-type payload discriminated union before writing.

## Seed Env Vars

The seed file uses Postgres `current_setting()` to read runtime values rather
than string interpolation, which would require shell escaping and risk
injection. Set them before running the seed:

```sql
SET app.seed_member1_name  = 'Alice Sun';
SET app.seed_member1_phone = '+15551112222';
SET app.seed_member2_name  = 'Bob Sun';
SET app.seed_member2_phone = '+15553334444';
SET app.seed_contact_name  = 'Dr. Rivera';
SET app.seed_contact_phone = '+15555556666';
```

Or pass them in a `.env`-style wrapper script that calls `psql -v` before
running the seed.
