# Design: dashboard-and-simulator

## Re-plan decisions (hackathon MVP, due Dec 4, 2026)

Supersedes the sections "Access control and RLS", "Live page" (the Realtime parts), "Calls and details" (live prepend), "Settings" and "Unread dot". Everything below those headings stays as the post-hackathon design.

- **Access control.** RLS is enabled on every table (households, contacts, family_members, calls, call_events, fraud_reports, mock_messages) with NO policies. The browser reads nothing directly; every read goes through a server component or route that uses the service role key.
- **One passcode.** The env var `DASHBOARD_PASSCODE` protects all dashboard pages, `/calls/*`, `/reports/*`, the settings routes and the live polling route. `proxy.ts` checks it and stores the result in an httpOnly cookie (the cookie holds a value derived from the passcode, never the passcode itself; compare in constant time). Read the Next.js proxy doc in `node_modules/next/dist/docs/` first, as AGENTS.md requires.
- **Outside the passcode:** `/api/voice/*` and `/api/sms/*`, which keep the `X-Twilio-Signature` check. This is an assumption; say so if you want them handled differently.
- **Deferred:** Supabase Auth, anonymous sessions, signed SMS tokens, `family_members.user_id`, the `calls_read` and `events_read` policies. The SMS carries the plain `/calls/{id}` link; the passcode page returns the visitor to it.
- **Live updates.** `/live` and `/calls/[id]` poll a server route every 2 seconds (task 25). Supabase Realtime (`lib/supabase-browser.ts`, `lib/realtime.ts`, `useLiveCall`) is deferred. `/calls` loads on page view with no live prepend.
- **Simulator.** Scenarios come from `tests/fixtures` (the 30 fixtures); import the JSON, do not copy it. The Simulate button needs the `is_demo` household, the `ENABLE_SIMULATOR` gate and the rate limit, and everything it creates is labelled SIMULATED.
- **Dev phone.** `/dev/phone` is exempt from the 16 px text rule. It stays behind `ENABLE_DEV_TOOLS`.
- **Deferred:** Settings page CRUD (the demo household is seeded with SQL; the time-waster toggle moves with it), unread dot, Realtime, dev phone tests, full accessibility audit.

## What exists today (read from the files)

- `app/` has only the starter `page.tsx`, a root `layout.tsx` titled "Create
  Next App", the report page (needs `report-client.tsx`), `app/dev/phone/*`
  (page and 30 KB client) and routes under `app/api/dev/phone/*` and
  `app/api/voice/*`. `app/api/simulate/` holds only `.gitkeep`. There is no
  `app/(dashboard)`.
- No code subscribes to Realtime. `createBrowserClient()` exists in
  `lib/db.ts` and is never imported. The migration adds `calls` and
  `call_events` to the `supabase_realtime` publication.
- `lib/providers/` (index, telephony, ai) implements mock, Ollama, Gemini and
  Twilio selection.
- `components/ui/` has badge, button, card, dialog, input, switch, table, tabs
  and toast (shadcn "base-nova" on `@base-ui/react`, class merging from the
  `cn` package).

## Route map (target)

```
instrumentation.ts                 register(): assertProvidersSafe()
proxy.ts                           session check for dashboard routes (Next 16 name for middleware)
app/
  layout.tsx                       dark theme, title "Ghostline", Toast provider
  page.tsx                         redirect("/live")
  (dashboard)/
    layout.tsx                     header + nav (server), UnreadDot (client)
    live/page.tsx                  Live (server shell + <LiveCall/>)
    calls/page.tsx                 Calls table
    calls/[id]/page.tsx            Call details
    settings/page.tsx              Settings
  api/
    simulate/route.ts              POST start
    simulate/step/route.ts         POST one step
    settings/household/route.ts    PATCH name, time_waster_enabled
    settings/safe-word/route.ts    POST
    settings/contacts/route.ts     POST;  contacts/[id]/route.ts  PATCH, DELETE
    settings/members/route.ts      POST;  members/[id]/route.ts   PATCH, DELETE
  dev/phone/*  api/dev/phone/*     exist; gated by devToolsEnabled()
lib/
  turn.ts                          processTurn(): one turn, shared by 3 callers
  finalize-call.ts                 finalizeCall(): end time, outcome, alerts, report
  live-status.ts                   deriveLiveStatus(call, events, now)  (pure)
  realtime.ts                      applyChange(state, payload)          (pure)
  unread.ts                        unread set helpers (pure)
  dev-gate.ts                      devToolsEnabled()
  simulator/scenarios.ts           scenario ids -> fixture lines
  simulator/run.ts                 startSimulation(), nextStep()
  providers/assert.ts              assertProvidersSafe()
  supabase-browser.ts              one browser client per tab
supabase/migrations/0004_dashboard.sql
```

Pages stay thin. Data and rules live in `lib/`.

## Shared turn code

Three places run a conversation turn today or soon: `/api/voice/turn`,
`/api/dev/phone/turn` and the simulator. The first two already duplicate the
persistence steps (write the transcript, run `engine()`, write `state_change`,
update the call). A fourth copy would drift. `processTurn({ callSid,
speech, source })` in `lib/turn.ts` does all of it (transcript write, safe-word
redaction, engine, state change with time-waster extras, `updateCall`, alert
trigger) and returns `{ reply, nextState, hangup, ... }`. Each route only
adapts input and output: Twilio form to TwiML, JSON for the dev phone, and a
script line for the simulator. This depends on conversation-and-scoring task 1
(the live route using the real engine).

`finalizeCall(call)` is the end of a call: set `ended_at`, outcome, the
time-waster exit event, the MEDIUM alert and the HIGH report. The status
webhook and the simulator both call it.

## Live page

```
server: pick active call (ended_at is null and started < 15 min ago),
        load events, fraud report, household masked contacts
client: <LiveCall initial={...}/>
  useLiveCall(callId):
    channel = browser.channel("live:"+householdId)
      .on(postgres_changes, calls, filter household_id=eq.H)     // new/updated call
      .on(postgres_changes, call_events, filter call_id=eq.C)    // events of the active call
      .subscribe(status => setConnection(status))
    after SUBSCRIBED: fetch events since lastSeen, merge   // subscribe, then backfill
    applyChange(state, payload)   // dedupe by id, sort by created_at
    poll every 3 s if status is CHANNEL_ERROR or TIMED_OUT
  status = deriveLiveStatus(call, events, now)
```

When a new call row arrives and the current one has ended, the page switches
to it. `call_events` has no `household_id`, so the events subscription is
filtered by the active `call_id` and re-created when the call changes. RLS
(below) scopes what each browser receives.

`deriveLiveStatus` is pure and returns:

```
{ level, score, flags: [{ id, label, quote }],
  safeWord: "not_asked" | "asked" | "passed" | "failed", attempts,
  callback: "not_initiated" | "calling" | "pending" | "confirmed" | "denied" | "no_answer",
  timeWasted: { startedAt, endedAt, seconds, running } | null,
  transcript: [{ id, speaker, text, at }], state, simulated }
```

It reuses `call-evidence.ts` (alerts-and-report) and `timeWastedSummary`
(time-waster). The timer re-renders every second from `now`, which is passed
in, so tests need no fake clock.

Components (shadcn only): `Card`, `Badge`, `Button`, `Tabs`, `Dialog` (simulate
confirm), `Table`. The risk meter is a `div` bar styled with Tailwind inside a
`role="meter"` wrapper (no extra library). Add shadcn `progress` and
`scroll-area` through the shadcn CLI if preferred.

## Calls and details

`/calls`: `getRecentCalls(householdId, 25)` plus one query for
`fraud_reports.call_id in (...)` to show the Report link. "Load more" passes a
`started_at` cursor. A Realtime `calls` INSERT prepends a row.
`/calls/[id]`: uuid validated with zod, then `notFound()`. Events come from
`getCallEvents`. Marks the call viewed on mount.

## Settings

Server routes validate with zod and check the session's household. They call
`updateHousehold`, `createContact`, `deleteContact`, `createMember`,
`updateMember`, `deleteMember` helpers (to add to `lib/db.ts`). The page loads
a `HouseholdPublic` shape without `safe_word_hash`, plus `safe_word_set`.
Safe word: `normalise()` (safe-word-and-callback spec), then
`bcrypt.hash(word, 12)`, then update. Plaintext is never logged.

## Unread dot

`unread.ts` keeps `viewed: Set<callId>` in `localStorage["ghostline:viewed:"+householdId]`.
Unread = calls with level medium or high and not viewed, from the initial list
plus Realtime inserts and updates. The dot is a client component in the server
layout. With accounts, a `call_views` table replaces `localStorage`.

## Access control and RLS

Migration `0004_dashboard.sql`:

```sql
ALTER TABLE households ENABLE ROW LEVEL SECURITY;
-- same for contacts, family_members, calls, call_events, fraud_reports, mock_messages
ALTER TABLE households     ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE family_members ADD COLUMN user_id uuid REFERENCES auth.users(id);
ALTER TABLE calls          ADD COLUMN is_simulated boolean NOT NULL DEFAULT false;

CREATE POLICY calls_read ON calls FOR SELECT TO authenticated USING (
  household_id IN (SELECT household_id FROM family_members WHERE user_id = auth.uid())
  OR household_id IN (SELECT id FROM households WHERE is_demo));
CREATE POLICY events_read ON call_events FOR SELECT TO authenticated USING (
  call_id IN (SELECT id FROM calls));          -- inherits the calls policy
-- no policy on households, contacts, family_members, fraud_reports, mock_messages:
-- with RLS on, the browser gets nothing; the server uses the service role.
```

Realtime `postgres_changes` applies these policies to each subscriber. Check
the Supabase docs for the exact behaviour of filters with RLS before relying
on them.

Sign-in (open decision). Default:

| Who | How |
|---|---|
| Family member | Supabase Auth email link. `family_members.user_id` links the account. |
| Judge | Supabase anonymous sign-in (enable it in the project); sees demo household only, read-only. |
| SMS link | `/calls/{id}?t=<signed token>`: HMAC over call id and expiry (7 days) with a server secret. A valid token lets a phone open that call and its report once, then sets a short-lived cookie. |

Alternative if accounts cannot be built in time: a household access code
checked by `proxy.ts`, with the browser reading through a server route that
polls every 2 seconds instead of Realtime. State which was chosen in the PR.

`proxy.ts` (called `middleware.ts` in older Next.js; see
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`)
redirects unauthenticated requests to sign-in. Route handlers and server
components still check the session themselves; the proxy is only the first
gate.

## Simulator

```
POST /api/simulate { scenarioId }
  gate: ENABLE_SIMULATOR === "true" else 404
  household = demo household (is_demo) else 403
  limits: last simulated call started < 30 s ago -> 429; > 50 today -> 429
  call = createCall({ call_sid: "SIM_"+uuid, from_number: "+15550100000",
                      is_simulated: true, state: "screening" })
  return { callSid, callId, total, willSendRealSms }

POST /api/simulate/step { callSid, index }
  verify call is simulated, not ended
  expected = number of caller lines already stored
  index !== expected -> 409
  line = SCENARIOS[scenarioId].lines[index]      // the server owns the text
  result = processTurn({ callSid, speech: line.text, source: "simulator" })
  if line.callbackAnswer: recordCallbackResult(...)   // no outbound call
  last line or terminal state -> finalizeCall(call)
  return { line, reply, level, score, state, done }
```

The client drives the pace: after each response it waits 1.5 s and posts the
next index (a `setTimeout` loop in the Simulate component). One request per
line keeps every request inside the platform limit (a whole replay in one
request would be 5 lines x (1.5 s + up to 6 s for the AI) and could pass 10 s).
If the tab closes mid-run, the call stays open until the Live page's
15-minute active window passes. The call sid is `SIM_<scenarioId>_<uuid>`, so
the step endpoint finds the script from the sid without a new column.

Scenarios are ids into `tests/fixtures/scams.json` and `legitimate.json`
(conversation-and-scoring task 4), imported as JSON so there is one source.
Each fixture may carry `callbackAnswer: "denied" | "confirmed" | "no_answer"`
and `safeWord: "correct" | "wrong"` for the grandchild cases. A safe word step
sends the household's real word only when the scenario says `correct`, taken
from `SIMULATOR_SAFE_WORD` (env, demo household only), never from the client.

SMS bodies and the report for a simulated call carry the SIMULATED prefix and
header. `buildAlertSms` (alerts spec) takes `call.is_simulated`.

## Providers and test mode

| Setting | Result |
|---|---|
| `MOCK_TELEPHONY=true` | `MockTelephony` writes `mock_messages`, logs masked numbers |
| unset or other | `TwilioTelephony` (throws without credentials) |
| `AI_PROVIDER=mock` | rules-only scripted replies |
| `AI_PROVIDER=ollama` | local model at `OLLAMA_URL` |
| `AI_PROVIDER=gemini` or unset | Gemini |
| anything else | error listing the valid values |

`assertProvidersSafe()` runs from `instrumentation.ts` `register()`, which
Next.js calls once at server start (see
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`).
When `VERCEL_ENV === "production"` it throws if `MOCK_TELEPHONY=true`,
`AI_PROVIDER` is `mock` or `ollama`, or the value is unknown. The lazy checks
inside `createTelephonyProvider` and `createAIProvider` stay as a second line
of defence. `.env.example` ends with `AI_PROVIDER=ollama` uncommented today.
Move it to a commented dev block and list `ENABLE_SIMULATOR` and
`ENABLE_DEV_TOOLS`.

## Dev tools

`devToolsEnabled()` = not `VERCEL_ENV === "production"` and
(`ENABLE_DEV_TOOLS === "true"` or `NODE_ENV === "development"`). It replaces
the inline `VERCEL_ENV` checks in `app/dev/phone/page.tsx` and the five
`app/api/dev/phone/*` routes. The dev page is exempt from the 16 px rule (it is
developer-only) but keeps dark theme and colour-plus-label risk. Callback
buttons: **Press 1** denied, **Press 2** confirmed, **No answer**, matching
the spoken prompt in safe-word-and-callback.

## Known defects in the current code (verified by reading the files)

1. No dashboard pages, header, Live page, call list, details or Settings. The
   home page is the Next.js starter. `app/layout.tsx` is titled "Create Next
   App" and has no dark class.
2. `app/globals.css` defines only `--background` and `--foreground` (switching
   by `prefers-color-scheme`). The tokens the shadcn components use
   (`bg-primary`, `text-muted-foreground`, `border-border`, and so on) are not
   defined, so the components render unstyled.
3. No Realtime client code anywhere. `createBrowserClient()` is unused.
4. No RLS on any table and no grants or policies. The public anon key can
   read and write all tables, including `households.safe_word_hash`.
5. `app/api/simulate/` is empty. No scenarios exist.
6. `instrumentation.ts` does not exist. The mock-in-production check runs when
   `getTelephony()` or `getAI()` is first called, and inside route handlers the
   thrown error is caught and turned into fallback TwiML, so a bad production
   config fails quietly instead of at startup. Ollama is accepted in
   production.
7. `.env.example` sets `AI_PROVIDER=ollama` and `MOCK_TELEPHONY=false` as live
   lines. `ENABLE_SIMULATOR` and `ENABLE_DEV_TOOLS` are not listed.
8. The dev phone is gated by `VERCEL_ENV !== "production"` only, so a Vercel
   preview deployment exposes it, with service-role access, to anyone.
9. Dev phone callback buttons are reversed (It's me = press 1, Not me =
   press 2) versus the prompt in the safe-word spec.
10. The dev turn route repeats the turn logic of `/api/voice/turn` and writes
    the transcript before the engine (so the latest utterance is duplicated in
    the history). It returns the callback target's full phone number in JSON.
11. The inbox API returns full numbers and bodies. The page shows only the last
    four digits.
12. Nothing writes `mock_messages` yet: `MockTelephony` is reached only through
    `lib/alerts.ts`, which no route calls.
13. `lib/db.ts` has `Database = any`, no `updateHousehold`, contact or member
    helpers, and `HouseholdSchema` includes `safe_word_hash`.
14. The previous design put the call list at `/`, had no Live page, ran the
    whole replay inside one request, accepted any `householdId`, and gated on
    `NODE_ENV` as well as `ENABLE_SIMULATOR`.

## Testing strategy

| File | Covers |
|---|---|
| `tests/live-status.test.ts` | `deriveLiveStatus`: every safe word and callback state, flags with quotes, timer running and frozen, transcript order |
| `tests/realtime-merge.test.ts` | `applyChange`: dedupe, ordering, call switch, late events |
| `tests/unread.test.ts` | Unread set from calls and views |
| `tests/simulate.test.ts` | 404 without the flag, 403 non-demo, unknown scenario 400, 429 limits, 409 step order, server-only text, SIMULATED labels, ends finalised, expected levels (mock AI, fixtures) |
| `tests/settings.test.ts` | Validation, safe word hashed with cost 12 and never echoed, no `safe_word_hash` in any response, 401 without a session |
| `tests/providers.test.ts` | Selection matrix, production guard for each mock and Ollama, unknown value |
| `tests/dev-gate.test.ts` | Gate for production, preview, development |
| `tests/rls.sql` or a script | With the anon key: `select * from households` returns nothing; a member sees only their household's calls |
| Manual | Simulate end to end (see tasks) |
