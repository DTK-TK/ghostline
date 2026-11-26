# Tasks: alerts-and-report

Status was checked by reading the code and imports, not from earlier notes.

Rule for `[x]`: the code fully does it AND it is wired (an `app/api/voice/*`
route or a page that builds reaches it). The previous version of this file
checked about ten items and cited `tests/alerts.test.ts` and
`tests/report.test.ts`, which do not exist. One of those marks even said
"pending a test". Those marks were removed.

What exists but is not wired: `sendAlerts`, `buildAlertSms`,
`buildChecklistSms` in `lib/alerts.ts` (nothing outside the file imports them);
`buildAndStoreReport`, `loadReport`, `buildCafcText` in `lib/report.ts` (only
the report page imports `loadReport` and `buildCafcText`, and that page does
not compile); `getAlertRecipients`, `getFraudReport`, `createFraudReport` in
`lib/db.ts`; the `fraud_reports` table; `MockTelephony.sendSms`.
`app/reports/[id]/page.tsx` exists but cannot build without `report-client.tsx`.

---

## Open tasks, in priority order

- [ ] **1. Create `app/reports/[id]/report-client.tsx` so `npx tsc --noEmit` passes.**
  A `"use client"` default export taking `{ cafcText: string }` (add the time
  fields from task 14 later). A read-only textarea with the CAFC text, a
  shadcn `Button` "Copy for CAFC report" (clipboard with a toast on success and
  a visible message on failure), a shadcn `Button` "Print" (`window.print()`),
  both `print:hidden`. 16 px minimum text, dark theme. Either implement the
  `?print=1` behaviour promised in the page header comment or delete that
  sentence.
  - _Proof: `npx tsc --noEmit` exits 0 (today the only error is
    `Cannot find module './report-client'`). Manual: open `/reports/{id}`, click
    Copy, paste into a text editor and see the full CAFC block._

- [ ] **2. Add `alert_type` to the `alert_sent` payload schema in `lib/db.ts`.**
  `alert_type: z.enum(["risk", "checklist"])`. Also add the optional fields the
  new flow uses: `level`, `recipient_id`, `status` (`sending`, `sent`,
  `failed`). `lib/alerts.ts` already sends `alert_type`.
  - _Proof: `tests/alert-event-schema.test.ts`: `CallEventPayloadSchema` accepts
    a risk and a checklist payload and rejects a payload with no `alert_type` or
    with `alert_type: "other"`; `npx tsc --noEmit` passes._

- [ ] **3. Replace the dynamic `import()` calls in `lib/report.ts` with static imports.**
  Import `adminDb`, `CallSchema` and `FraudReportSchema` at the top. Remove the
  unused `getCallBySid` and `getHousehold` imports. Optionally add
  `getCallById()` to `lib/db.ts` instead of the inline query.
  - _Proof: `Select-String lib\report.ts -Pattern 'await import\('` finds
    nothing; `npx tsc --noEmit` passes; `tests/report.test.ts` mocks
    `@/lib/db` with `vi.mock` and `buildAndStoreReport` returns a report built
    from the mocked call and events._

- [ ] **4. Test: alerts are sent only once per call, even if HIGH is reported on several turns.**
  `tests/alerts-once.test.ts`. Mock `@/lib/providers` so `getTelephony()`
  returns `{ sendSms: vi.fn() }`. Mock `@/lib/db` with a stateful fake
  (`appendEvent` stores events, `getCallEvents` returns them,
  `getAlertRecipients` returns two members with `gets_alerts: true`,
  `getHousehold` returns the household).
  (a) Call `sendAlerts` with a HIGH context three times (three turns): the
  mock has been called exactly 4 times in total (2 recipients x risk and
  checklist), and each (recipient, type) pair once. With `paymentMethod: null`
  it is 2 calls.
  (b) `Promise.all([sendAlerts(ctx), sendAlerts(ctx)])` sends each pair once
  (needs task 8).
  (c) Through `alertCall(callId)` three times with a HIGH call, then once more
  from the status route path: still the same total (needs task 5).
  - _Proof: `npx vitest run tests/alerts-once.test.ts`. Case (a) passes against
    today's code once the file is importable; (b) and (c) fail until tasks 8
    and 5 land._

---

## Further open tasks

- [ ] **5. Wire the triggers.** Add `lib/alert-call.ts` (`alertCall(callId)`) and
  call it when a call becomes HIGH (engine, callback-result, hold-check), when a
  MEDIUM call takes a message, and from `/api/voice/status` on call end, which
  also calls `buildAndStoreReport(call.id)` for HIGH calls. Alert and report
  failures are caught and never change the response. Check Next.js
  `after()` in `node_modules/next/dist/docs/` first, as `AGENTS.md` requires.
  - _Proof: `tests/alert-call.test.ts` (HIGH now, MEDIUM waits for end, LOW none,
    no recipients is fine) and `tests/voice-status.test.ts` (alerts for medium
    and high, report only for high, 204 even when alerting throws)._

- [ ] **6. Persist amount and payment method.** Migration `0003`: add
  `calls.requested_amount` and `calls.payment_method`. Add them to `CallSchema`
  and `CallInsertSchema`. The engine writes the latest non-empty AI value, with
  a rules-based extraction when the AI is down, and never overwrites with an
  empty value. `report.ts` reads them instead of `null`. Needs
  conversation-and-scoring task 1.
  - _Proof: `tests/conversation.test.ts`: "send $500 in gift cards" sets both;
    a later turn without them keeps them; a Gemini failure still sets the
    payment method._

- [ ] **7. Red-flag quotes.** `scoreRules` returns `matches: { flag, quote }[]`;
  the engine writes `quote` on each `red_flag` event (instead of "rules-only" or
  "ai+rules"); the report uses `quote`. Update the zod schemas.
  - _Proof: `tests/scoring-rules.test.ts` (quote contains the matched phrase,
    cut to 200 characters) and `tests/report.test.ts` (report flags carry
    quotes; CAFC text shows them)._

- [ ] **8. At-most-once sending.** Migration unique index on `call_events` for
  `alert_sent` (call, alert_type, recipient_id). In `lib/alerts.ts`: claim
  before sending, per-recipient `try/catch`, `Promise.allSettled`, status
  `sending`/`sent`/`failed`, retry only failed claims.
  - _Proof: `tests/alerts-once.test.ts` case (b); a failing `sendSms` for one
    recipient still sends to the other and leaves a `failed` claim that a later
    call retries once._

- [ ] **9. SMS body.** New template, per-field limits (40, 20, 20), cleaning of
  URLs, control and non-GSM characters, link never cut, ASCII `...`, `pending`
  callback value.
  - _Proof: `tests/alerts.test.ts` with fast-check: for any strings, body is at
    most 320 characters, contains the dashboard link and the level tag, and
    contains no `http`, `www.` or character outside GSM-7 from the inputs; the
    example from R3 matches exactly._

- [ ] **10. Money-move checklist.** Rewrite `buildChecklistSms` as steps chosen by
  payment method, naming the callback target from `getCallbackTargets()`, at
  most 320 characters, no caller text. Send only when `payment_method` is set.
  - _Proof: `tests/alerts.test.ts`: four payment branches, contact named,
    fallback "a family member", `paymentMethod: null` sends no second SMS._

- [ ] **11. One scam-type heuristic.** `lib/scam-type.ts` with whole-word
  matching; delete the dead copy in `alerts.ts` and the old one in
  `report.ts`.
  - _Proof: `tests/scam-type.test.ts`: each category; identities "Jason",
    "Kirsten" and "Crabtree" are not impersonation scams._

- [ ] **12. Unique report per call.** Migration: `UNIQUE` index on
  `fraud_reports(call_id)`; insert with conflict handling that returns the
  existing row.
  - _Proof: `tests/report.test.ts`: two concurrent `buildAndStoreReport` calls
    return the same row id and create one row (stateful fake)._

- [ ] **13. Report page to the UI rules.** Dark theme on screen, white in print,
  base text 16 px or larger, shadcn `Card`/`Badge`, risk colours green-500,
  amber-500, red-500 with text labels, quotes shown, invalid or unknown id gives
  `notFound()`, `noindex`, `force-dynamic`.
  - _Proof: manual: `/reports/not-a-uuid` shows 404; print preview is white with
    no buttons; `Select-String "app\reports" -Pattern "text-sm|bg-white"` finds
    nothing outside `print:` variants._

- [ ] **14. Time zone.** Show the viewer's local time and UTC on the page, and
  ISO with zone in `buildCafcText`.
  - _Proof: `tests/report.test.ts`: CAFC text date matches `/\d{4}-\d{2}-\d{2}T.*Z/`._

- [ ] **15. Privacy of logs.** Add or reuse `maskPhone`. `sendAlerts`,
  `alertCall` and `MockTelephony` log no full numbers and no SMS bodies.
  - _Proof: `tests/alerts.test.ts`: spy on `console.log`/`console.error` during
    a send with a real-looking number; no call contains the number or the body._

- [ ] **16. Access control for the report and call links.** Follow the
  dashboard-and-simulator decision. Until then the id is the only protection.
  - _Proof: decision recorded in that spec; test or manual check once chosen._

- [ ] **17. End-to-end check.** Simulate a HIGH call with a gift-card script and
  two alert recipients: each gets one risk SMS and one checklist SMS (dev inbox
  or real teammate numbers), a repeated status callback sends nothing more, the
  report exists once, and the page prints and copies correctly.
  - _Proof: manual run recorded in the PR._

---

## Requirement checklist (checked against the code)

- [ ] **R1** Triggers. Nothing calls `sendAlerts`. Task 5.
- [ ] **R2** Recipients. `getAlertRecipients` exists in `lib/db.ts` and
  `sendAlerts` uses it and returns on an empty list, but it is not wired and
  untested. Tasks 4, 5.
- [ ] **R3** Risk SMS. Builder exists, but truncation cuts the link and caller
  text is not cleaned. Task 9.
- [ ] **R4** Checklist SMS. Current text is a reminder, not steps. Task 10.
- [ ] **R5** At most once. Read-then-send, racy. Tasks 4, 8.
- [ ] **R6** Alert events. No `alert_type` in the schema. Tasks 2, 8.
- [ ] **R7** Failure isolation. One failure aborts the loop. Tasks 5, 8.
- [ ] **R8** Evidence. No amount or payment columns, no quotes. Tasks 6, 7.
- [ ] **R9** Fraud report. Builder exists, never called, dynamic imports,
  amount and payment always `null`. Tasks 3, 5, 6, 7, 11, 12.
- [ ] **R10** CAFC text. `buildCafcText` exists and is used by the page, but the
  page does not compile and the text lacks quotes and time zone. Tasks 1, 7, 14.
- [ ] **R11** Report page. Does not build; breaks the UI rules. Tasks 1, 13, 14, 16.
- [x] **R12** Never submit automatically. No code in `lib/report.ts`,
  `lib/alerts.ts` or any route sends report data to an external service (no
  `fetch` or HTTP client in those files; the only outbound path is the
  telephony provider's SMS to family members).
  - _Proof: `Select-String lib\report.ts, lib\alerts.ts -Pattern 'fetch\(|axios|http\.request'`
    finds nothing; the page footer states nothing is submitted._
- [ ] **R13** Privacy. `MockTelephony` logs full numbers and bodies. Task 15.
- [ ] **R14** Verification. No alert or report tests exist. Tasks 2, 3, 4, 8, 9 to 12.
