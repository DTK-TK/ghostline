# Requirements: dashboard-and-simulator

## Overview

Family members set up and watch Ghostline in a web dashboard with three pages:
**Live** (the call happening now), **Calls** (history, with details and the
fraud report) and **Settings**. A **Simulate** button replays a fixture call
through the real engine and alert code so judges can see the whole product
without a phone. A **test mode** (mock telephony and AI, a mock inbox and a
browser phone at `/dev/phone`) lets the team build and test with no Twilio or
Gemini account.

Sources of truth: `ui.md`, `privacy.md`, `tech.md`, `product.md`.

---

## R1. Who can see what

The dashboard shows transcripts, phone numbers and the household's settings.
Today nothing protects them:

- the migrations enable no row-level security (RLS) on any table;
- the browser uses `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which is public, so anyone
  who opens the site could read every table directly, including
  `households.safe_word_hash`, and could write to them.

Requirements:

1. RLS is enabled on every table. The service role (server only) bypasses it.
2. A signed-in family member can read only their household's `calls` and
   `call_events`. That is what makes Realtime in the browser safe.
3. The browser can never read `safe_word_hash`. Settings responses report only
   whether a safe word is set.
4. Dashboard pages, settings routes and report pages require a signed-in
   member of the household. A page or API route that fails the check returns
   a redirect to sign-in or 401/404, never the data.
5. A demo household (`is_demo = true`) can be viewed by judges without an
   account (read-only) and is the only household the simulator can run on.

The sign-in method is an open decision (see design.md). Default: Supabase Auth
email link for members, anonymous sessions for the demo household, and a
signed expiring token on the SMS link so a phone can open one call.

---

## R2. Layout, theme and branding (`ui.md`)

- Dark theme everywhere, built only with shadcn/ui components and Tailwind.
- Header on every dashboard page: a cassette-tape icon, "GHOSTLINE" in a
  monospace font, navigation (Live, Calls, Settings), and a red blinking dot
  with the visible text "message" when there are unread alerts. The blinking
  stops under `prefers-reduced-motion`; the text label stays.
- Base text 16 px or larger. The theme tokens shadcn components need (primary,
  card, muted, border, and so on) are defined in `app/globals.css`.
- Every risk shown with both colour and a text label: LOW green-500, MEDIUM
  amber-500, HIGH red-500.
- `/` redirects to `/live`. The Next.js starter page is gone, and the page
  title is "Ghostline".

---

## R3. Live page (`/live`)

Shows the active call, or an idle state ("No active call" with the last call
below it). The active call is the household's newest call with no `ended_at`
that started in the last 15 minutes. Parts:

1. **Transcript**: scrolling list, newest at the bottom, speaker labels
   (CALLER, GHOSTLINE), auto-scroll that pauses if the viewer scrolls up and
   shows a "Jump to latest" button.
2. **Red-flag chips**: one per flag, readable name plus the caller's quote.
3. **Risk meter**: bar from 0 to 100 with marks at 40 and 70, the score, and
   the label LOW, MEDIUM or HIGH. Exposed with `role="meter"`.
4. **Safe word status**: not asked, asked, passed, or failed (with attempt
   count of 2). Never shows the word or the attempt text.
5. **Callback status**: not initiated, calling (masked family member),
   pending, confirmed, denied, or no answer.
6. **Time-wasted timer**: "Scammer time wasted: mm:ss", counting up while the
   persona is active and frozen after it ends. Hidden if the persona never ran.
7. **Call state** and caller identity (claimed identity, masked number).
8. A **SIMULATED** badge when the call is simulated.
9. A connection indicator ("Live", "Reconnecting..").

---

## R4. Real-time behaviour

- The page subscribes with Supabase Realtime (`postgres_changes`) to the call
  row and its `call_events`, and to new calls of the household.
- Order is subscribe first, then fetch what already exists, then merge, so no
  event is lost in between. Events are de-duplicated by id and sorted by time.
- A dropped connection reconnects and refetches missed events. If Realtime is
  unavailable the page polls every 3 seconds and says so.
- Initial data comes from server components using the service role. The
  browser uses only the anon key, with the signed-in session, for Realtime.
  The service role key never reaches a `"use client"` file.
- An update appears on screen within 2 seconds of the database write.

---

## R5. Calls page (`/calls`)

A shadcn table of past calls, newest first: start time (with time zone),
caller number (masked), claimed identity, risk (colour + label), score,
outcome, a SIMULATED badge when relevant, a "Details" link, and a "Report"
link when a fraud report exists. 25 rows per page with "Load more". New calls
appear at the top live.

---

## R6. Call details (`/calls/[id]`)

Transcript, red flags with quotes, safe word and callback results, the event
timeline, time wasted, outcome, and the fraud report (link to
`/reports/[id]`, or "A report is created when a HIGH call ends"). An active call
updates live. Opening the page marks the call as viewed. An unknown or
malformed id returns 404. This is the page the alert SMS links to.

---

## R7. Settings page (`/settings`)

- **Family name**: required, at most 40 characters, letters, spaces, hyphens,
  apostrophes (it is spoken in the greeting).
- **Safe word**: write-only. Two password fields (new, confirm), 3 to 40
  characters. The value is normalised, hashed with bcrypt (cost 12) on the
  server and never returned, logged or stored in plain text. The page shows
  only "Safe word is set".
- **Trusted contacts**: add, edit, remove (name, phone, relationship).
- **Family members**: add, edit, remove (name, phone, "Gets alerts",
  "Is callback target"). The page warns when nobody is a callback target or
  nobody gets alerts.
- **Time-waster**: a switch for `time_waster_enabled`.
- Phone numbers are E.164 and validated. Every change saves through a server
  route with an immediate confirmation, and a failure is shown, not silent.
- A saved change applies to the next call. Calls in progress are not changed.

---

## R8. Unread alerts

The header dot shows when a MEDIUM or HIGH call has not been viewed. Viewing
means opening its details page. The state lives per device (`localStorage`,
keyed by household) until accounts exist, and updates without a reload when a
new alerting call arrives.

---

## R9. Simulate button

On the Live page (demo household only), a "Simulate a call" control with a
scenario picker. Behaviour:

1. Pressing it starts a simulated call and replays a fixture transcript one
   caller line at a time with a 1.5-second delay per line.
2. Each line goes through the same turn code as a real call (the real
   `engine()`, scoring, state changes, time-waster, callback result for
   scenarios that have one, alerts and report), so the Live page shows the
   transcript, flags, meter, safe word and callback status, and timer exactly
   as for a real call.
3. When the lines end the call is finalised the same way a hang-up is: end
   time, outcome, alert (MEDIUM at the end, HIGH already sent), and the fraud
   report for HIGH.
4. The browser never sends caller text. The server owns the script, so the
   endpoint cannot be used to push arbitrary text through the AI.
5. Scenarios come from the fixture transcripts (conversation-and-scoring
   task 4): grandparent, CRA, bank or tech support, a legitimate doctor's
   call, and a real grandchild who gives the safe word.

---

## R10. Simulator safety and labelling

- Everything simulated is labelled **SIMULATED**: the call row
  (`is_simulated`), the badge on every page, the SMS text ("SIMULATED:" prefix),
  the report header and the CAFC text, so nobody files a false complaint.
- Available only when `ENABLE_SIMULATOR=true`, otherwise 404. Runs only on a
  household with `is_demo = true`.
- Rate limited: one run per household per 30 seconds and at most 50 a day. A
  second request gets 429.
- Steps are numbered. A repeated or skipped step number gets 409.
- No outbound calls are placed. A callback step records a scripted result.
- SMS alerts go through the active telephony provider. With real telephony the
  button first asks for confirmation ("This sends real SMS to the demo
  family").
- Demo data uses fake names and teammates' verified numbers only.

---

## R11. Test mode and providers

All external services go through `lib/providers`.

- `MOCK_TELEPHONY=true` selects `MockTelephony`: SMS and callback calls are
  written to `mock_messages` and logged with masked numbers.
- `AI_PROVIDER` is `mock`, `ollama` or `gemini` (default `gemini`). Any other
  value is an error.
- When `VERCEL_ENV=production`, selecting any mock (and Ollama, which cannot
  run on Vercel) is a **startup error**: the server refuses to boot with a
  clear message, instead of failing on the first call. Twilio signature
  validation is never skipped in production.
- `.env.example` documents `MOCK_TELEPHONY`, `AI_PROVIDER`, `OLLAMA_URL`,
  `OLLAMA_MODEL`, `ENABLE_SIMULATOR` and `ENABLE_DEV_TOOLS`, and its defaults
  are safe to copy.

---

## R12. Mock inbox

`mock_messages` holds every SMS and callback call that `MockTelephony` sends.
The inbox shows them newest first with masked numbers and refreshes within
3 seconds. It is readable only when dev tools are enabled.

---

## R13. `/dev/phone`

A browser phone for development:

- a caller who can type or talk (push to talk with the browser's speech
  recognition, with Ghostline's replies spoken back);
- a household picker and a caller number;
- callback buttons that match the spoken prompt: **Press 1** (family member
  says they are safe and NOT calling, result denied), **Press 2** (it really is
  them, result confirmed), **No answer**;
- the mock inbox panel and a debug panel (state, score with label, flags);
- it uses the same turn code as the real webhooks.

It returns 404 in production.

---

## R14. Dev tools gate

`/dev/phone` and `/api/dev/*` work only when `VERCEL_ENV` is not `production`
and `ENABLE_DEV_TOOLS=true` (or `NODE_ENV=development`). They use the service
role, so a Vercel preview deployment must not expose them by default.

---

## R15. Accessibility

Every button, switch and link has an accessible name. Risk is never shown by
colour alone. Dynamic regions (transcript, status) use `aria-live="polite"`.
Keyboard navigation reaches every control, with visible focus.

---

## R16. Verification

- Unit tests with no credentials: live status derivation, the Realtime merge
  function, unread logic, settings routes, simulator gate, limits and step
  order, provider selection and the production guard, dev gate.
- Manual check: click Simulate, watch the whole flow on the Live page, and see
  the alert in the mock inbox.
