# Tasks: dashboard-and-simulator

Status was checked by reading the code and imports, not from earlier notes.

Rule for `[x]`: the code fully does it AND it is wired and reachable. The
earlier version of this file had nothing checked, which was correct for the
dashboard, but it did not account for the existing test-mode pieces below.

What exists but is not wired: `createBrowserClient()` in `lib/db.ts` (no
importer), the `supabase_realtime` publication for `calls` and `call_events`
(no subscriber), `MockTelephony` (reached only through `lib/alerts.ts`, which no
route calls), the lazy production guard in `lib/providers/index.ts`,
`components/ui/*`.

---

## Done and wired

- [x] **`mock_messages` table and the inbox (read side).** Migration
  `0002_mock_messages.sql`, `GET /api/dev/phone/inbox`, and the Mock Inbox panel
  in `app/dev/phone/phone-client.tsx` (polls every 3 s, shows the last four
  digits of the number). Nothing writes to it yet (see task 21), so it is
  empty until alerts are wired.
  - _Proof: read `app/api/dev/phone/inbox/route.ts` and the panel; manual check
    in task 24 confirms rows appear._

- [x] **`/dev/phone` browser phone.** `app/dev/phone/page.tsx` (404 when
  `VERCEL_ENV === "production"`), `phone-client.tsx`, and the four routes under
  `app/api/dev/phone/` (start, turn, callback-answer, inbox), each with the same
  production 404. Typed input and push-to-talk (`SpeechRecognition`) callers,
  spoken replies, household picker, callback card, debug panel with risk colour
  and label. It runs the real `engine()`. Gaps (reversed buttons, preview
  exposure) are tasks 19 and 20.
  - _Proof: read the files; documented in `DEV-PHONE.md`. Not covered by an
    automated test (task 22)._

---

## Open tasks, in priority order

- [ ] **1. Theme and shell.** Define the shadcn theme tokens in
  `app/globals.css` (dark values for background, foreground, card, primary,
  muted, border, input, ring, destructive) and always use the dark theme (class
  `dark` on `<html>`, remove the `prefers-color-scheme` switch). Fix the
  metadata (title "Ghostline"). Mount the toast provider. Replace the starter
  `app/page.tsx` with `redirect("/live")`.
  - _Proof: manual: a `Button`, `Card` and `Badge` render with colours on a dark
    page; `/` lands on `/live`; browser tab says "Ghostline"._

- [ ] **2. Decide and build access control (R1).** Pick the sign-in method
  (default in design.md). Migration `0004_dashboard.sql`: enable RLS on all
  tables, `calls_read` and `events_read` policies, `family_members.user_id`,
  `households.is_demo`. Add `proxy.ts` (read the Next.js proxy doc first) and
  session checks in server components and routes. The SMS link token from
  design.md.
  - _Proof: `tests/rls.sql` or a script run with the anon key: `select * from
    households` returns no rows, a member sees only their household's calls, an
    anonymous judge sees only the demo household; `tests/settings.test.ts`: 401
    without a session._

- [ ] **3. Extract `processTurn()` and `finalizeCall()`.** `lib/turn.ts` and
  `lib/finalize-call.ts`; `/api/voice/turn`, `/api/dev/phone/turn` and the
  status route become thin adapters. Needs conversation-and-scoring task 1.
  - _Proof: `tests/voice-turn.test.ts` and `tests/voice-status.test.ts` still
    pass; the dev phone and the voice route produce identical events for the
    same script (one shared test)._

- [ ] **4. `lib/live-status.ts`.** `deriveLiveStatus(call, events, now)`
  (pure), using `call-evidence.ts` and `timeWastedSummary`.
  - _Proof: `tests/live-status.test.ts`: safe word asked, passed, failed with
    attempts; callback calling, pending, denied; timer running then frozen; no
    attempt text appears in the output._

- [ ] **5. Header and navigation.** `app/(dashboard)/layout.tsx` with the
  `CassetteTape` icon from `lucide-react`, "GHOSTLINE" in `font-mono`, nav
  links, and the unread dot with visible "message" text, `motion-safe:animate-pulse`.
  - _Proof: manual: header on all three pages; with reduced motion on, the dot
    does not pulse and the "message" text stays._

- [ ] **6. Realtime client and merge.** `lib/supabase-browser.ts` (one client per
  tab), `lib/realtime.ts` `applyChange`, hook `useLiveCall` (subscribe, backfill,
  reconnect, 3 s poll fallback, connection state).
  - _Proof: `tests/realtime-merge.test.ts`: duplicate event ignored, out-of-order
    events sorted, new call replaces an ended one; manual: stop the network, the
    page says "Reconnecting.." and catches up after._

- [ ] **7. Live page `/live`.** Transcript with auto-scroll and "Jump to latest",
  red-flag chips with quotes, risk meter (`role="meter"`, marks at 40 and 70,
  label), safe word status, callback status, time-wasted timer, state, SIMULATED
  badge, idle state, connection indicator. Text 16 px or larger.
  - _Proof: manual with the dev phone: each element updates while a gift-card
    call runs; two browser tabs update together within 2 s._

- [ ] **8. Calls page `/calls`.** Table with all columns, masked numbers, SIMULATED
  badge, Details and Report links, "Load more" (25 rows), live prepend.
  - _Proof: manual: a new call appears at the top without a reload; a HIGH call
    shows a Report link._

- [ ] **9. Call details `/calls/[id]`.** Everything in R6, uuid validation and
  404, marks the call viewed, live updates while active. Requires the report
  page work in alerts-and-report.
  - _Proof: manual: open the link from an alert SMS; `/calls/not-a-uuid` is 404._

- [ ] **10. Settings data layer.** Add `updateHousehold`, contact and member
  helpers to `lib/db.ts` and a `HouseholdPublic` schema without
  `safe_word_hash`.
  - _Proof: `tests/settings.test.ts`: no response contains `safe_word_hash` or
    a bcrypt string._

- [ ] **11. Settings routes.** `app/api/settings/household`, `safe-word`,
  `contacts`, `contacts/[id]`, `members`, `members/[id]` with zod validation, E.164
  phones, session and household checks. Safe word: `normalise()` then
  `bcrypt.hash(word, 12)`; never logged or returned.
  - _Proof: `tests/settings.test.ts`: stored hash starts with `$2b$12$` and
    verifies with `bcryptjs`; plaintext absent from response and `console`;
    invalid phone 400; CRUD round trip; name with markup rejected._

- [ ] **12. Settings page.** Family name, write-only safe word (new and confirm,
  "Safe word is set"), contacts and members tables with `Dialog` forms and
  `Switch`es, time-waster switch, warnings for no callback target or no alert
  recipient, toast on success and on failure.
  - _Proof: manual: change each setting, reload, it persists; the safe word
    field is empty after saving and nothing shows the old word._

- [ ] **13. Unread dot logic.** `lib/unread.ts` plus the client component.
  - _Proof: `tests/unread.test.ts`; manual: a HIGH call lights the dot, opening
    its details clears it, a second call lights it again without a reload._

- [ ] **14. Migration columns.** `calls.is_simulated`, `households.is_demo`;
  seed marks the demo household `is_demo = true`; schema types updated.
  - _Proof: `supabase db reset` runs clean; `CallSchema` parses a row with the
    new column._

- [ ] **15. Simulator core.** `lib/simulator/scenarios.ts` (ids into the 30
  fixtures; needs conversation-and-scoring task 4), `startSimulation`,
  `nextStep` (server-owned text, index check, scripted callback answer, scripted
  safe word from `SIMULATOR_SAFE_WORD`).
  - _Proof: `tests/simulate.test.ts`: each scenario reaches its expected level
    with the mock AI; step 2 before step 1 gives 409; the request body cannot
    change the text._

- [ ] **16. Simulator routes and button.** `POST /api/simulate` and
  `/api/simulate/step`: `ENABLE_SIMULATOR` gate (404), demo household only (403),
  limits (429), `SIM_<scenario>_<uuid>` call sid, `finalizeCall` at the end. The
  Live page button with a scenario picker, a 1.5-second `setTimeout` between
  steps, progress text, a confirm dialog when telephony is real, and the SIMULATED
  label.
  - _Proof: `tests/simulate.test.ts`: 404, 403, 429 (30 s), daily cap, ends
    finalised with a report for HIGH; manual in task 24._

- [ ] **17. SIMULATED labelling downstream.** SMS prefix "SIMULATED:" (counts toward
  the 320 limit), report header and CAFC text, badges on Live, Calls and details.
  - _Proof: `tests/alerts.test.ts` (prefix, length), `tests/report.test.ts`
    (header), manual: badges visible._

- [ ] **18. Startup guard for providers.** `lib/providers/assert.ts` and
  `instrumentation.ts` (`register()`; read the Next.js instrumentation doc
  first). In production, any mock, Ollama or unknown value stops startup with a
  clear message. Fix `.env.example` (dev lines commented, add `ENABLE_SIMULATOR`,
  `ENABLE_DEV_TOOLS`, `SIMULATOR_SAFE_WORD`).
  - _Proof: `tests/providers.test.ts`: each of `MOCK_TELEPHONY=true`,
    `AI_PROVIDER=mock`, `AI_PROVIDER=ollama` and an unknown value throws when
    `VERCEL_ENV=production`, and none throws in `development` and `preview`;
    default AI is gemini; manual: `VERCEL_ENV=production MOCK_TELEPHONY=true npm run build && npm start`
    refuses to boot._

- [ ] **19. Dev tools gate.** `lib/dev-gate.ts` `devToolsEnabled()` used by
  `app/dev/phone/page.tsx` and all `app/api/dev/phone/*` routes.
  - _Proof: `tests/dev-gate.test.ts`: production false, preview false without
    `ENABLE_DEV_TOOLS`, development true; manual: `/dev/phone` is 404 on a preview
    URL._

- [ ] **20. Dev phone callback buttons.** Labels and digits to match the prompt:
  Press 1 = denied, Press 2 = confirmed, No answer. Use `recordCallbackResult`
  (safe-word-and-callback task 12). Stop returning the full callback number in
  the turn JSON. Remove `time_wasted` from the terminal list (time-waster task 13).
  - _Proof: manual: Press 1 blocks the call and raises the score; Press 2 lowers
    it by 40; No answer changes nothing._

- [ ] **21. MockTelephony in the loop.** Once `alertCall` is wired
  (alerts-and-report task 5), SMS and callback rows reach `mock_messages`. Mask
  numbers in the inbox API response and in `MockTelephony` logs.
  - _Proof: `tests/alerts-once.test.ts`/manual: an alert for a HIGH dev-phone call
    appears in the Mock Inbox; no full number in the server log._

- [ ] **22. Dev phone and inbox tests.** Route tests for start, turn, callback-answer
  and inbox using the helpers in `tests/helpers/voice.ts` style.
  - _Proof: `npx vitest run tests/dev-phone.test.ts` passes._

- [ ] **23. Accessibility pass.** Names on every control, `aria-live="polite"` on the
  transcript and status areas, focus styles, text size, colour plus label for every
  risk.
  - _Proof: manual axe or Lighthouse run on `/live`, `/calls`, `/calls/[id]`,
    `/settings`: no "must have accessible name" or "colour only" findings._

- [ ] **24. Manual check: Simulate, end to end.** With `MOCK_TELEPHONY=true`,
  `ENABLE_SIMULATOR=true`, `ENABLE_DEV_TOOLS=true`, `AI_PROVIDER=mock` (or
  gemini), open `/live` in one tab and `/dev/phone` in another. Click **Simulate a
  call**, choose the grandparent scenario, and confirm: lines arrive 1.5 s
  apart with a SIMULATED badge; the transcript scrolls; red-flag chips appear with
  quotes; the risk meter climbs to HIGH with the label; safe word and callback
  status update; the time-wasted timer runs (set `TIME_WASTER_SECONDS=20`) and
  stops; the call ends. Then in `/dev/phone`, confirm the alert SMS (prefixed
  SIMULATED:) is in the Mock Inbox, exactly once per family member, plus the
  checklist SMS. Open `/calls` and see the call with its Report link.
  - _Proof: recorded in the PR with a screen capture; repeat once with
    `legitimate_caller` and confirm LOW, no alert, no report._

---

## Requirement checklist (checked against the code)

- [ ] **R1** Who can see what. No RLS, no sign-in. Task 2.
- [ ] **R2** Layout and theme. No header; theme tokens missing. Tasks 1, 5.
- [ ] **R3** Live page. Does not exist. Tasks 4, 7.
- [ ] **R4** Real-time behaviour. No client code. Task 6.
- [ ] **R5** Calls page. Does not exist. Task 8.
- [ ] **R6** Call details. Does not exist. Task 9.
- [ ] **R7** Settings. Does not exist. Tasks 10, 11, 12.
- [ ] **R8** Unread alerts. Does not exist. Task 13.
- [ ] **R9** Simulate button. Empty `app/api/simulate`. Tasks 15, 16.
- [ ] **R10** Simulator safety and labelling. Tasks 14, 16, 17.
- [ ] **R11** Test mode and providers. Factory and lazy guard exist; no startup
  error, Ollama allowed in production, unsafe `.env.example`, no tests. Task 18.
- [ ] **R12** Mock inbox. Read side exists (done above); needs writers and masking.
  Task 21.
- [ ] **R13** `/dev/phone`. Typed and spoken caller, inbox panel, debug panel and
  the production 404 exist (see "Done and wired"). Still open: the callback
  buttons are reversed against the prompt (task 20).
- [ ] **R14** Dev tools gate. `VERCEL_ENV` only. Task 19.
- [ ] **R15** Accessibility. Task 23.
- [ ] **R16** Verification. No tests for any of this. Tasks 4, 6, 11, 13, 15, 18, 19, 22, 24.
