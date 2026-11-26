# Design — alerts-and-report

## Overview

Alerting and reporting are post-call concerns. `sendAlerts()` fires SMS
messages via Twilio. `buildAndStoreReport()` assembles a structured JSONB
document from the event log. The report page renders both and provides a
copy-to-clipboard CAFC text block.

---

## Module layout

```
lib/
  alerts.ts             sendAlerts(), buildAlertSms(), buildChecklistSms()
  report.ts             buildAndStoreReport(), loadReport(), buildCafcText()
app/
  api/voice/status/
    route.ts            calls sendAlerts() + buildAndStoreReport() on call end
  reports/[id]/
    page.tsx            server component — renders report
    report-client.tsx   client component — clipboard + print buttons
```

---

## Alert dispatch

`sendAlerts()` is called from `/api/voice/status` after `updateCall()` sets
`ended_at`. It is also safe to call from the turn route when a terminal
HIGH-risk state is set during the conversation (belt-and-suspenders in case
the status webhook is delayed).

```
sendAlerts(context: AlertContext)
        │
        ▼
getHousehold(householdId)
getAlertRecipients(householdId)   ← family_members WHERE gets_alerts = true
        │
        ▼
sentAlertKeys(callId)             ← existing alert_sent events → Set<"risk:+1…" | "checklist:+1…">
        │
        ▼
for each recipient:
  riskKey = "risk:" + recipient.phone
  if (!sent.has(riskKey)):
    twilio.messages.create({ to, from, body: buildAlertSms(context, dashboardUrl) })
    appendEvent(alert_sent, { channel:"sms", recipient, alert_type:"risk" })

  if (paymentMethod && !sent.has("checklist:" + recipient.phone)):
    twilio.messages.create({ to, from, body: buildChecklistSms(seniorName, cbName) })
    appendEvent(alert_sent, { channel:"sms", recipient, alert_type:"checklist" })
```

### SMS body builders

**`buildAlertSms(context, dashboardUrl)`** (≤ 320 chars):

```
GHOSTLINE {LEVEL}: Caller claimed to be {who}. Asked for {amt} via {pay}.
Safe word: {sw}. Callback: {cb}. {dashboardUrl}
```

Values are caller-supplied; the function trims the body to 317 chars + "…"
if the total exceeds 320.

**`buildChecklistSms(seniorName, familyContactName)`**:

```
Reminder for {seniorName}: no bank, police or family member will ever ask for
gift cards, crypto, wire transfers or a courier pickup. Call {familyContactName}
directly on their saved number.
```

Both are pure functions — no I/O, fully unit-testable.

### Idempotency key schema

```
alert_sent event payload:
{
  type: "alert_sent",
  channel: "sms",
  recipient: "+1XXXXXXXXXX",   ← E.164, never logged to console
  alert_type: "risk" | "checklist"
}
```

`sentAlertKeys` builds the set `"risk:+1…"` and `"checklist:+1…"` from these
events. Any second call to `sendAlerts` skips already-keyed pairs.

---

## Report assembly

`buildAndStoreReport(callId)` loads the call record and all its events, then
assembles a `FraudReportData` object validated by `FraudReportDataSchema`
(Zod). The object is stored in `fraud_reports.report` as JSONB. The function
is idempotent — it checks for an existing row first.

### Evidence extractors

| Extractor | Source events |
|---|---|
| `extractTranscript()` | `type = "transcript"` |
| `extractRedFlags()` | `type = "red_flag"` |
| `extractSafeWordResult()` | `type = "safe_word_attempt"` — last one wins |
| `extractCallbackResult()` | `type = "callback_result"` — last one wins |

### Scam-type heuristic (`guessScamType`)

Derives a human-readable scam category from `claimed_identity` and flag IDs.
Priority order: emergency story + family keywords → "grandparent scam"; CRA/
IRS → "CRA / IRS impersonation"; police/RCMP → "law enforcement
impersonation"; Microsoft/tech → "tech support scam"; bank/card → "bank /
card fraud"; remote_access → "remote access scam"; payment_method →
"payment / gift card scam"; emergency_story → "emergency story scam";
fallback → "suspicious call".

---

## Report page

`/reports/[id]` is a Next.js server component. It calls `loadReport(id)` and
`buildCafcText(data)` at render time, then passes `cafcText` to the client
component `<ReportClient>` for the clipboard button.

```
page.tsx (server)
  loadReport(id) → { row, data }  [throws notFound() if null]
  buildCafcText(data) → string
  render:
    <header>  — report ID + risk badge (colour + text label)
    <Summary> — dl with all structured fields
    <RedFlags> — flag_id tags + detail
    <Transcript> — ordered list, speaker colours
    <ReportClient cafcText={...} />  — clipboard + print (client)
    <footer>  — CAFC link + "nothing submitted automatically"
```

The page uses white background and standard Tailwind `print:` variants so
the browser print dialog produces a clean PDF. Action buttons are hidden
in print view (`print:hidden`).

---

## `buildCafcText()` format

```
=== CAFC FRAUD REPORT (copy and paste into the online form) ===

Date and time:       {locale string}
Caller number:       {E.164}
Claimed identity:    {string | "not stated"}
Scam type:           {string}
Amount requested:    {string | "not stated"}
Payment method:      {string | "not stated"}
Safe word result:    {passed | failed | not asked}
Callback result:     {denied | confirmed | no_answer | not initiated}
Risk score:          {n}/100 ({LEVEL})

Red flags detected:
  • {flag_id}: {detail}
  …

Summary:
  {one sentence}

Full transcript:
  [CALLER]  {text}
  [SYSTEM]  {text}
  …

=== END OF REPORT ===
Report a fraud: https://antifraudcentre-centreantifraude.ca/reportincident-…
```

---

## Privacy

`sendAlerts()` calls `twilio.messages.create()` with the recipient's phone
number as `to`. That phone number must NOT appear in `console.log`. The
`appendEvent` payload stores the number in the DB (needed for idempotency
key lookup) but log statements must mask it (e.g. show only the last 4
digits).

---

## Testing strategy

| Test file | What it covers |
|---|---|
| `tests/alerts.test.ts` | `buildAlertSms` truncates at 320 chars; `buildChecklistSms` names the contact; idempotency: second call skips already-sent keys |
| `tests/report.test.ts` | `buildCafcText` includes all fields; `guessScamType` heuristic for each category; `extractSafeWordResult` returns "not asked" with no events |
| Manual | Trigger a HIGH-risk simulated call; verify SMS arrives on a real number; open `/reports/{id}` and confirm all fields render; use "Copy for CAFC report" button |
