# Requirements — alerts-and-report

## Overview

When a call reaches MEDIUM or HIGH risk, Ghostline must immediately alert the
family by SMS and, for HIGH-risk calls, generate a structured fraud report the
family can use to file a complaint with the Canadian Anti-Fraud Centre (CAFC).
Nothing is submitted automatically.

---

## R1 — Alert trigger

`sendAlerts()` must be called for every call that ends at MEDIUM (40–69) or
HIGH (≥ 70) risk. It must be called from the status webhook (`/api/voice/status`)
after the call ends, or from the turn route when a terminal HIGH-risk state is
reached.

---

## R2 — Alert recipients

Alerts must be sent to every `family_members` row for the household where
`gets_alerts = true`. If no such rows exist, `sendAlerts()` must return
without error.

---

## R3 — Primary risk-alert SMS

Each alert recipient must receive one SMS containing:

- The risk level tag (`MEDIUM` or `HIGH`).
- The caller's claimed identity (or "unknown" if not stated).
- The amount requested (or "none").
- The payment method mentioned (or "none").
- The safe-word result (`passed`, `failed`, or `not asked`).
- The callback result (`denied`, `confirmed`, `no_answer`, or `not initiated`).
- A direct link to the call detail page on the dashboard:
  `{PUBLIC_BASE_URL}/calls/{call.id}`.

The SMS body must not exceed 320 characters (two segments). Values supplied
by the caller (identity, amount, payment method) must be truncated if the
total would exceed the limit.

---

## R4 — Money-move checklist SMS

When a payment method is mentioned on the call (`calls.payment_method` is not
null), a second SMS must be sent to the same recipients containing a plain-
language reminder that no legitimate bank, police officer, or family member
will ever ask for gift cards, cryptocurrency, wire transfers, or a courier
pickup. The message must name the primary callback contact so the senior knows
who to call directly.

---

## R5 — Idempotency

`sendAlerts()` must be safe to call more than once for the same call. Before
sending each message, it must check `call_events` for an existing
`alert_sent` event keyed by `{alert_type}:{recipient_phone}`. If a matching
event exists, that message must be skipped.

---

## R6 — Alert event logging

After each SMS is sent successfully, the system must append an `alert_sent`
event to `call_events` with:

- `channel = "sms"`
- `recipient` = the recipient's E.164 phone number
- `alert_type` = `"risk"` or `"checklist"`

Phone numbers in this payload must not appear in `console.log` output.

---

## R7 — Fraud report generation

For every HIGH-risk call, `buildAndStoreReport()` from `lib/report.ts` must
be called after the call ends. The report must be stored once (idempotent:
if a row already exists for the call it is returned as-is) in
`fraud_reports.report` as JSONB.

The report must include:

- `date_time`, `caller_number`, `claimed_identity`.
- `scam_type` — a human-readable guess derived from the flags and claimed
  identity (e.g. "grandparent scam", "CRA impersonation").
- `amount` and `payment_method` from the call record.
- `red_flags` — array of `{ flag_id, detail }` from `call_events`.
- `safe_word_result` — `"passed" | "failed" | "not asked"`.
- `callback_result` — `"denied" | "confirmed" | "no_answer" | "not initiated"`.
- `transcript` — full conversation from `call_events` of type `transcript`.
- `risk_score` and `risk_level`.
- `summary` — Gemini's one-sentence summary from `calls.summary`.

---

## R8 — CAFC text export

`buildCafcText(report)` must return a plain-text block formatted for the CAFC
online reporting form at antifraudcentre-centreantifraude.ca. The block must
include all report fields in a clearly labelled, human-readable format. It
must end with the CAFC report URL.

The text must never be submitted automatically. It must only be presented to
the family for manual copy-paste.

---

## R9 — Report page

`/reports/[id]` must display the full fraud report in a print-friendly layout
(white background, Tailwind `print:` variants to hide action buttons). The
page must include:

- A summary section with all structured fields.
- The red-flags list.
- The full transcript.
- A client-side "Copy for CAFC report" button that copies `buildCafcText()`
  output to the clipboard.
- A print button.
- A legal footer noting that nothing has been submitted automatically and
  linking to the CAFC report form.

---

## R10 — No auto-submission

The system must never automatically submit any data to police, CAFC, or any
third-party reporting service. The family must initiate all external reporting.
Fraud reports are for the family's reference only.

---

## R11 — Privacy

The alert SMS body must not log API keys, auth tokens, or full phone numbers
in `console.log` or `console.error`. Phone numbers may appear in the SMS body
(the recipient's own number is on their own device) but must be masked if
logged server-side.
