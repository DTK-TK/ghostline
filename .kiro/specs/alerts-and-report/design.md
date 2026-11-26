# Design: alerts-and-report

## Module layout (target)

```
lib/
  alerts.ts          buildAlertSms(), buildChecklistSms(), sendAlerts()
  alert-call.ts      alertCall(callId): builds context from the DB, decides
                     MEDIUM/HIGH, calls sendAlerts()                      (new)
  call-evidence.ts   extractTranscript(), extractRedFlags(),
                     extractSafeWordResult(), extractCallbackResult()     (new,
                     moved from report.ts so alerts and report share them)
  scam-type.ts       guessScamType() with whole-word matching             (new)
  report.ts          buildAndStoreReport(), loadReport(), buildCafcText()
  mask-phone.ts      maskPhone() shared with safe-word-and-callback       (new
                     here if that spec has not added it yet)
app/
  api/voice/status/route.ts   on call end: alertCall() + report for HIGH
  reports/[id]/page.tsx       server component
  reports/[id]/report-client.tsx   client: copy + print                   (new)
supabase/migrations/0003_alerts_report.sql
```

Routes stay thin and call `lib/`.

## Trigger points

```
HIGH reached (engine turn, callback-result, hold-check)  -> alertCall(call.id)
MEDIUM message taken (conversation spec)                 -> alertCall(call.id)
status webhook, call ended                               -> alertCall(call.id)
                                                            if risk_level high: buildAndStoreReport(call.id)
```

Every trigger calls the same idempotent function, so repeats are harmless.
`alertCall(callId)`:

```
call   = getCallById(callId)
level  = call.risk_level (critical -> high)
if level not in {medium, high}: return
if level == medium and call not ended and no message taken: return   // wait for end
events = getCallEvents(callId)
context = {
  call, level,
  claimedIdentity: call.claimed_identity,
  requestedAmount: call.requested_amount,
  paymentMethod:   call.payment_method,
  safeWordResult:  extractSafeWordResult(events),
  callbackResult:  extractCallbackResult(events),   // adds "pending"
}
await sendAlerts(context)
```

Context is always read from the database, so every trigger sends the same
data. Alert failures are caught inside `alertCall` and logged with masked
numbers.

Platform note: `AGENTS.md` says this Next.js version differs from older ones.
Before using `after()` from `next/server` to send after the response, read
`node_modules/next/dist/docs/`. If it is not suitable, `await` with a 3 s
timeout around the parallel sends.

## At-most-once sending

Today `sendAlerts()` reads existing `alert_sent` events, sends, then writes
the event. Two concurrent calls both read an empty set and both send, and if
`appendEvent` fails after a send, the next call sends again.

New flow per (call, recipient, alert type):

```
1. claim: insert alert_sent {status:"sending", alert_type, recipient_id, level}
   unique index (call_id, alert_type, recipient_id) where type='alert_sent'
   -> unique violation: someone else owns it. If the existing row has
      status "failed", try a compare-and-set to "sending". Otherwise skip.
2. telephony.sendSms(member.phone, body)      // per-recipient try/catch
3. success: update row status "sent".  failure: status "failed" (masked log)
```

Recipient sends run with `Promise.allSettled`. The unique index is the lock,
so no extra table is needed. A recipient removed or renumbered later does not
affect past rows because the key is the member id.

Migration `0003_alerts_report.sql`:

```sql
ALTER TABLE calls
  ADD COLUMN requested_amount text,
  ADD COLUMN payment_method   text;
CREATE UNIQUE INDEX call_events_alert_once
  ON call_events (call_id, (payload->>'alert_type'), (payload->>'recipient_id'))
  WHERE type = 'alert_sent';
CREATE UNIQUE INDEX fraud_reports_call_id_key ON fraud_reports (call_id);
-- drop the old non-unique fraud_reports_call_id_idx afterwards
```

`call_events` is described as append-only. Updating the `status` of a claim
row is the one exception, and only for `alert_sent`.

## SMS bodies

`buildAlertSms(context, dashboardUrl)`:

1. Clean each caller-supplied value: remove control characters, URLs
   (`https?://`, `www.`) and domain-like tokens, collapse whitespace, replace
   non-GSM-7 characters, then cut to 40 / 20 / 20 characters.
2. Fill the template in R3.
3. If still over 320, shorten `who` (floor 10 characters). The URL and the
   level tag are never cut. Use `...` (ASCII), not `…`, which would force
   unicode encoding.

Length check: the fixed text is about 190 characters at the maximum field
sizes, leaving about 130 for the URL, so a base URL up to roughly 80
characters fits before `who` has to shrink. 320 characters is three GSM-7
segments (153 each for concatenated messages), not two as the old comment said.

`buildChecklistSms(familyName, contactName, paymentMethod, reportOrCallLink)`:
picks one of four step sets (gift card, crypto/wire/e-transfer, courier,
other) by whole-word match on the payment method. It uses the callback
target's name from `getCallbackTargets()`, not from the alert recipients, and
falls back to "a family member".

Example (gift card, under 320 characters):

```
GHOSTLINE STEPS: 1) Call Alex first. 2) Send no more money. 3) Gift card: keep the card and receipt, call the issuer now. 4) Keep all receipts. {link}
```

## Report assembly

`buildAndStoreReport(callId)` uses static imports from `@/lib/db`
(`adminDb`, `CallSchema`, `FraudReportSchema`, helpers). It builds the report
from the call row (now including amount and payment method) and from
`call-evidence.ts`. The insert uses the unique index: on conflict it reads
the existing row, so a retry never creates a second report and
`getFraudReport()` never sees two rows.

`FraudReportDataSchema.red_flags` becomes `{ flag_id, quote }[]`. Quotes come
from the `red_flag` event payload `quote`, written by the engine from the
rules matches (`scoreRules` returns `matches: { flag, quote }[]`; the quote is
the caller utterance containing the match, cut to 200 characters). AI-only
flags carry the utterance the AI was answering.

`scam-type.ts` uses `\b` word boundaries. The current patterns match
substrings: `cra` matches "Crabtree", `irs` matches "Kirsten", and `son`
matches "Jason", so those names become impersonation scams.

## Report page

```
page.tsx (server)
  id = uuid(params.id) or notFound()
  loadReport(id) or notFound()
  metadata: robots noindex; dynamic = "force-dynamic"
  render: header (risk badge: colour + text), summary, red flags with quotes,
          transcript, <ReportClient cafcText iso times />, footer
report-client.tsx ("use client")
  shadcn Button "Copy for CAFC report" (navigator.clipboard, toast on success,
  error text on failure), shadcn Button "Print" (window.print()),
  read-only textarea with the CAFC text, local-time display
```

Screen: dark theme, `text-base` or larger, shadcn `Card`, `Badge`, `Button`.
Print (`print:` variants): white background, black text, buttons hidden, the
transcript fully expanded.

## `buildCafcText()` format

Unchanged labels. Differences: date is ISO with zone (`2026-01-05T14:03:00Z`)
and each red flag line is `  - flag_id: "quote"`.

## Known defects in the current code (verified by reading the files)

1. Nothing imports `sendAlerts`, `buildAndStoreReport` or `getFraudReport`
   outside `lib/` and the report page. `/api/voice/status` calls neither.
2. `app/reports/[id]/report-client.tsx` does not exist. It is the only error
   from `npx tsc --noEmit`.
3. `calls` has no amount or payment-method column. `report.ts` sets both to
   `null` with a comment claiming the engine writes them. The engine does not.
   `AlertContext.requestedAmount` and `paymentMethod` have no source.
4. The engine writes `red_flag.detail` as "rules-only" or "ai+rules", not the
   caller's words, so reports cannot show quotes.
5. The `alert_sent` schema in `lib/db.ts` has no `alert_type`. It works today
   because the zod object is not strict.
6. `sendAlerts()` reads then sends then logs. Concurrent calls double-send. A
   failing SMS throws out of the loop and skips the remaining recipients.
7. `buildAlertSms` truncates with `slice(0, 317) + "…"`, which cuts off the
   dashboard link when a caller-supplied value is long, and the `…` forces
   unicode encoding. Caller text is placed in the SMS unfiltered.
8. `buildChecklistSms` is a reminder, not a checklist. The caller passes the
   family name as "seniorName" ("Reminder for Sun"). The contact is looked up
   among alert recipients only.
9. `guessScamType` exists in both `alerts.ts` (unused) and `report.ts`
   (substring regexes).
10. `fraud_reports.call_id` has a non-unique index. Two reports for one call
    are possible and would make `getFraudReport()` (`maybeSingle`) error.
11. `lib/report.ts` uses dynamic `await import("@/lib/db")` in two places
    and imports `getCallBySid` and `getHousehold` without using them.
12. The page uses `bg-white`, `text-sm` (14 px), plain Tailwind elements, and
    yellow instead of amber. It formats times with the server's locale and
    time zone. An invalid id string reaches the database and likely throws.
    Its header promises `?print=1`, which nothing implements.
13. The SMS link points at `/calls/{id}`. No `app/(dashboard)` exists yet.
14. `MockTelephony` logs full phone numbers and the full SMS body.
15. The previous `tasks.md` marked items `[x]` with proofs in
    `tests/alerts.test.ts` and `tests/report.test.ts`. Neither file exists.

## Testing strategy

| File | Covers |
|---|---|
| `tests/alerts.test.ts` | Template, truncation, link kept, cleaning, GSM chars, checklist branches (fast-check on length and link) |
| `tests/alerts-once.test.ts` | Once per call across repeated HIGH turns and concurrent calls, mocked telephony provider and a stateful fake `@/lib/db` |
| `tests/alert-call.test.ts` | Level rules: HIGH now, MEDIUM waits, LOW none, no recipients |
| `tests/report.test.ts` | Static-import builder, idempotency, quotes, scam type, `buildCafcText` |
| `tests/scam-type.test.ts` | Each category, and the names Jason, Kirsten, Crabtree |
| `tests/alert-event-schema.test.ts` | `alert_sent` payload schema |
| `tests/voice-status.test.ts` | Status webhook triggers alerts, and the report for HIGH only |
| Manual | Simulated HIGH call: one SMS per recipient in the dev inbox; second status callback sends nothing; report page and Copy button work |

The stateful fake of `@/lib/db` implements `appendEvent` with the unique-index
rule (throws a unique violation on a repeated key), so the concurrency test
exercises the same guarantee as the migration.
