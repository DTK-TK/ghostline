# Requirements — dashboard-and-simulator

## Overview

Family members monitor and configure Ghostline through a web dashboard.
A separate `/api/simulate` endpoint lets hackathon judges trigger a scripted
call without a real phone. This spec covers both the dashboard pages and the
simulator.

---

## R1 — Dashboard layout and branding

The dashboard must follow the UI rules:

- Dark theme throughout; built exclusively with shadcn/ui components and
  Tailwind. No custom design systems.
- Header: a cassette-tape answering-machine icon, "GHOSTLINE" in a monospace
  font, and a red blinking dot labelled "message" when there are unread
  alerts (calls where `risk_level` is `medium` or `high` and the family has
  not viewed the detail page).
- Base font size 16 px minimum.
- Risk level shown with both a colour swatch and a text label everywhere it
  appears (accessibility requirement).

Colour mapping:

| Risk level | Tailwind class |
|---|---|
| LOW | `text-green-500` / `bg-green-500` |
| MEDIUM | `text-amber-500` / `bg-amber-500` |
| HIGH | `text-red-500` / `bg-red-500` |

---

## R2 — Call list page (`/`)

The dashboard home page must display a table of recent calls for the
household, ordered newest-first, showing:

- Start time (formatted for the household's locale).
- Caller number (or "unknown").
- Claimed identity.
- Risk level (colour + label).
- Risk score (0–100).
- Outcome.
- A link to the call detail page.

The list must update in real time via Supabase Realtime without a page
refresh. New rows must appear at the top.

---

## R3 — Call detail page (`/calls/[id]`)

The call detail page must show:

- All fields from the call list entry.
- The full event timeline from `call_events`, oldest first.
- If a fraud report exists for this call, a link to `/reports/[report_id]`.
- If the call is still active (state ≠ terminal), a live-updating risk score
  and state via Supabase Realtime.

---

## R4 — Settings page (`/settings`)

The settings page must allow a family member to:

- View and edit the household name.
- View, add, and remove trusted contacts (name, phone, relationship).
- View, add, and remove family members (name, phone, `gets_alerts`,
  `is_callback_target` toggles).
- Enable or disable the time-waster feature (`households.time_waster_enabled`).
- Change the safe word (the new word must be bcrypt-hashed before storing;
  the current hash must never be displayed or echoed).

Changes persist immediately to Supabase via API calls.

---

## R5 — Unread alert indicator

The header must show a blinking red dot when any call in the household has
`risk_level IN ('medium', 'high')` and has not been marked as viewed. The dot
must disappear when all such calls have been viewed. Viewing is defined as
navigating to the call detail page.

The read/unread state must be stored client-side (e.g. `localStorage`) or in
a `calls` column. Either approach is acceptable as long as the indicator
updates without a page reload.

---

## R6 — Simulator endpoint (`POST /api/simulate`)

The simulator must accept a JSON body:

```json
{
  "scenario": "grandparent_scam" | "cra_scam" | "tech_support" | "legitimate_caller",
  "householdId": "<uuid>"
}
```

And must:

1. Look up the household.
2. Create a `calls` row as if a call had arrived.
3. Play through 3–5 scripted turns via the conversation engine, appending
   `transcript` and scoring events to `call_events`.
4. Run `sendAlerts()` and `buildAndStoreReport()` as appropriate based on the
   final risk level.
5. Return `{ callId, riskLevel, riskScore, outcome }` as JSON.

The endpoint must NOT require Twilio credentials and must NOT place a real
phone call. It is for demo and judging purposes only.

---

## R7 — Simulator security

The simulator endpoint must only be available when
`process.env.ENABLE_SIMULATOR === "true"`. In production (`NODE_ENV ===
"production"` and `ENABLE_SIMULATOR` not set), the route must return 404.

---

## R8 — Realtime updates

The dashboard must subscribe to Supabase Realtime changes on the `calls`
table filtered by `household_id`. On receiving an `UPDATE` or `INSERT` event
the UI must refresh the relevant row without a full page reload.

---

## R9 — Server vs browser client

Dashboard pages that need live data must use `createBrowserClient()` with the
anon key for the Realtime subscription. Data fetching for the initial render
must use server components with `adminDb()` (service role key). The anon key
must never appear in server-side code; the service role key must never be
sent to the browser.

---

## R10 — Accessibility

Every interactive element (buttons, toggles, links) must have an accessible
label. Risk indicators must not rely on colour alone — the text label
(`LOW`, `MEDIUM`, `HIGH`) must always accompany the colour swatch.
