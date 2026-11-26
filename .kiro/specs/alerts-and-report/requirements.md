# Requirements: alerts-and-report

## Overview

When a call reaches MEDIUM or HIGH risk, Ghostline alerts the family by SMS
through the telephony provider. After a HIGH call ends, it builds a fraud
report the family can print or copy into the Canadian Anti-Fraud Centre
(CAFC) form. Nothing is ever submitted automatically.

Sources of truth: `scam-rules.md` (bands), `privacy.md`, `product.md`,
`tech.md` (everything external goes through `lib/providers`), `ui.md`.

---

## R1. When alerts are sent

One risk SMS per call per recipient, at the highest level known when it is
sent:

- **HIGH:** immediately, on the first turn or event where the call becomes
  HIGH, whatever the cause (rules, AI, failed safe word, denied callback).
- **MEDIUM:** when the call takes a message or ends, so the SMS carries the
  final safe-word and callback results. If the call becomes HIGH first, the
  HIGH alert is the one that goes out.
- **Safety net:** the status webhook (`/api/voice/status`) tries again for any
  call that ended at MEDIUM or HIGH with no alert sent. `critical` is treated
  as HIGH. LOW never alerts.

A MEDIUM alert already sent is not followed by a second alert if the call
later becomes HIGH. The dashboard link shows the live state.

---

## R2. Recipients

Every `family_members` row of the household with `gets_alerts = true`. With
no such rows, alerting does nothing and does not fail.

---

## R3. Risk SMS

One SMS per recipient. Template:

```
GHOSTLINE {LEVEL}: Caller claims to be {who}. Amount: {amount}. Payment: {payment}. Safe word: {safe_word}. Callback: {callback}. {dashboard_link}
```

- `LEVEL` is `MEDIUM` or `HIGH`.
- `who`, `amount`, `payment` show `unknown` or `none` when empty.
- `safe_word` is `passed`, `failed` or `not asked`.
- `callback` is `denied`, `confirmed`, `no_answer`, `pending` or
  `not initiated`.
- `dashboard_link` is `{PUBLIC_BASE_URL}/calls/{call.id}`.
- The body is at most 320 characters. Caller-supplied values are shortened
  first (`who` 40, `amount` 20, `payment` 20 characters). The link is never
  cut off.
- Caller-supplied values are cleaned before use: control characters, URLs and
  domain-like text are removed, and characters outside the GSM-7 alphabet are
  replaced, so a caller cannot put a link or a unicode body (smaller segments)
  into the family's SMS.

---

## R4. Money-move checklist SMS

When a payment method was mentioned, each recipient gets a second SMS, also
at most 320 characters. It is a short list of steps, not a general warning:

1. call the family contact first (named, from the callback target);
2. do not send more money;
3. if money already moved, call the bank or card issuer now (for a gift card:
   keep the card and receipt and call the issuer; for crypto, wire or
   e-transfer: ask the bank to stop or recall it; for a courier pickup: hand
   over nothing);
4. keep receipts, card numbers and this call's report link.

The step text is picked from the payment method. The message never accuses
anyone and contains no caller-supplied text.

---

## R5. At most once

A given (call, recipient, alert type) is sent at most once, including when:

- the same HIGH level is reported on many turns;
- the turn route and the status webhook both ask;
- Twilio retries a webhook;
- two requests run at the same time.

The system records its claim before sending. A send that fails is marked
failed and may be retried later (the status webhook is the retry). A send
that succeeded is never repeated.

---

## R6. Alert events

Each alert writes an `alert_sent` event with `channel: "sms"`, `alert_type`
(`risk` or `checklist`), `recipient_id` (the family member id), `recipient`
(masked phone), `level` and `status` (`sending`, `sent`, `failed`). The
payload schema in `lib/db.ts` declares `alert_type`. Only `sent` events show
on the dashboard timeline.

---

## R7. Failure isolation

- One recipient's failed SMS does not stop the others.
- An alert failure never breaks the caller's TwiML response and never throws
  into a webhook. It is logged with masked numbers.
- Alerts run inside the webhook's 10-second budget (parallel sends, short
  timeout) or after the response where the platform allows it.

---

## R8. Evidence the alert and report need

The call record keeps what the caller said, so the alert and report can show
it:

- `claimed_identity` (exists), and new `requested_amount` and
  `payment_method` on `calls`.
- The engine writes the latest non-empty value from the AI. When the AI is
  unavailable, the rules layer extracts the payment method and amount. A later
  empty value never erases an earlier one.
- Each `red_flag` event stores `quote`: the caller's words that triggered it.

---

## R9. Fraud report

After a HIGH call ends, one report is built and stored for the call (the
status webhook is the trigger). A repeated trigger returns the existing report
and never creates a second row. It contains:

- date and time (ISO, with time zone), caller number, claimed identity;
- scam type (one shared heuristic, whole-word matching);
- amount, payment method;
- red flags, each with its quote;
- safe-word result, callback result;
- full transcript, in order (a safe-word attempt appears as redacted text);
- risk score and level, and the one-sentence summary.

---

## R10. CAFC text

`buildCafcText()` returns a plain-text block with every report field, in the
labelled order used today, ending with the CAFC reporting URL. It is shown
for the family to copy. It is never sent anywhere.

---

## R11. Report page `/reports/[id]`

- Shows summary, red flags with quotes, transcript, and the CAFC text in a
  visible text area with a "Copy for CAFC report" button and a Print button.
  Copy gives visible confirmation. If clipboard access fails the text can
  still be selected by hand.
- A print layout (white background, action buttons hidden). On screen it
  follows `ui.md`: dark theme, text at least 16 px, shadcn/ui components,
  risk shown with both colour (LOW green-500, MEDIUM amber-500, HIGH red-500)
  and a text label.
- Times show a time zone (viewer's local time and UTC).
- An id that is not a valid UUID or has no report gives a 404, not an error
  page. The page is `noindex` and not cached.
- Footer: "Nothing has been submitted automatically" and the CAFC link.
- Access control follows the dashboard's (dashboard-and-simulator spec). Until
  then the unguessable report id is the only protection (open decision).

---

## R12. Never submit automatically

No code sends report data to police, CAFC or any third party. The family
files any report themselves.

---

## R13. Privacy

- No full phone number, API key, auth token or SMS body in `console.*` output.
  Phone numbers are masked.
- The safe word, its hash and attempts never appear in alerts, reports or
  logs.
- Demo data uses fake names and teammates' verified numbers only.

---

## R14. Verification

Tests run with no Twilio, Gemini or Supabase credentials. The telephony
provider is mocked. Required: alerts are sent once per call even when HIGH is
reported on several turns or at the same time.
