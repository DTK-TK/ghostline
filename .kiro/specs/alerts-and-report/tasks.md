# Tasks — alerts-and-report

---

## R1 — Alert trigger

- [ ] `sendAlerts()` is called from `/api/voice/status/route.ts` for MEDIUM and
  HIGH calls after `updateCall()` sets `ended_at`.
  - _Proof: `tests/voice-status.test.ts` — mock `sendAlerts`; POST to the status
    route with a CallStatus that maps to a completed call; assert `sendAlerts` was
    called when risk_level is "medium" or "high"._

  > **Status:** `app/api/voice/status/route.ts` calls `updateCall()` and returns
  > 204 but does not call `sendAlerts()`. Task is open.

---

## R2 — Alert recipients

- [x] `sendAlerts()` calls `getAlertRecipients(householdId)` and returns without
  error when the result is empty.
  - _Proof: `tests/alerts.test.ts` — mock `getAlertRecipients` to return `[]`;
    call `sendAlerts`; assert no Twilio `messages.create` call and no error thrown._

---

## R3 — Primary risk-alert SMS

- [x] `buildAlertSms(context, dashboardUrl)` produces a body containing risk tag,
  claimed identity, amount, payment method, safe-word result, callback result,
  and dashboard URL.
  - _Proof: `tests/alerts.test.ts` — call with a fully populated context; assert
    all fields appear in the returned string._

- [x] Body is truncated to ≤ 320 characters with a trailing "…" when over the limit.
  - _Proof: `tests/alerts.test.ts` — supply a 400-char identity string; assert
    `result.length <= 320` and result ends with "…"._

---

## R4 — Money-move checklist SMS

- [x] `buildChecklistSms(seniorName, familyContactName)` returns a message naming
  both the senior and the callback contact.
  - _Proof: `tests/alerts.test.ts` — assert both names appear in the returned
    string._

- [ ] `sendAlerts()` sends the checklist SMS only when `context.paymentMethod` is
  not null.
  - _Proof: `tests/alerts.test.ts` — call with `paymentMethod=null`; assert only
    one Twilio `messages.create` call (risk only). Call again with a payment
    method; assert two calls._

  > **Status:** The logic is in `lib/alerts.ts` and appears correct, but there
  > are no tests to confirm it. Task is open until tests are written.

---

## R5 — Idempotency

- [x] `sendAlerts()` checks for existing `alert_sent` events before sending each
  message and skips already-sent pairs.
  - _Proof: `tests/alerts.test.ts` — pre-populate a `risk:+15550001111` event;
    call `sendAlerts`; assert Twilio is called 0 times for that recipient._

  > **Status:** The idempotency logic (`sentAlertKeys()`) is implemented in
  > `lib/alerts.ts`. Task marked [x] pending a formal test being written that
  > verifies the behaviour.

- [ ] Write `tests/alerts.test.ts` to formally verify idempotency end-to-end.
  - _Proof: `npx vitest run tests/alerts.test.ts` passes._

---

## R6 — Alert event logging

- [x] After each SMS, `appendEvent` is called with `type="alert_sent"`,
  `channel="sms"`, `recipient` (E.164), and `alert_type` ("risk" or "checklist").
  - _Proof: `tests/alerts.test.ts` — mock `appendEvent`; call `sendAlerts`; assert
    it is called with the correct payload._

- [ ] No `console.log` or `console.error` in `lib/alerts.ts` outputs a full phone
  number.
  - _Proof: `tests/alerts.test.ts` — spy on `console.log`/`console.error`; call
    `sendAlerts` with a known number; assert no log line contains the full E.164
    string._

---

## R7 — Fraud report generation

- [x] `buildAndStoreReport(callId)` is idempotent: calls `getFraudReport` first
  and returns the existing row if one is found.
  - _Proof: `tests/report.test.ts` — mock `getFraudReport` to return a row; call
    `buildAndStoreReport`; assert `createFraudReport` is never called._

- [x] Report includes all required fields: `date_time`, `caller_number`,
  `claimed_identity`, `scam_type`, `amount`, `payment_method`, `red_flags`,
  `safe_word_result`, `callback_result`, `transcript`, `risk_score`,
  `risk_level`, `summary`.
  - _Proof: `tests/report.test.ts` — call with a fully populated call + events;
    parse result through `FraudReportDataSchema`; assert no Zod errors._

- [ ] `buildAndStoreReport()` is called from the status webhook (or turn route)
  when risk level is HIGH.
  - _Proof: `tests/voice-status.test.ts` — mock `buildAndStoreReport`; simulate a
    completed HIGH-risk call; assert it was called._

  > **Status:** `lib/report.ts` exists and is complete, but nothing calls it yet.

---

## R8 — CAFC text export

- [x] `buildCafcText(report)` includes all required fields in the specified format
  and ends with the CAFC report URL.
  - _Proof: `tests/report.test.ts` — call with a known report; assert the output
    string contains each field label and the CAFC URL._

- [x] The CAFC text is never submitted automatically; it is only surfaced via the
  copy-to-clipboard button.
  - _Proof: Code review — `buildCafcText` is called only in `app/reports/[id]/page.tsx`
    and passed to `<ReportClient>` for display. No fetch/POST using this text._

---

## R9 — Report page

- [x] `/reports/[id]/page.tsx` renders a summary section, red-flags list, and full
  transcript.
  - _Proof: Manual — open `/reports/{known_id}`; confirm all sections are visible._

- [x] The page includes a "Copy for CAFC report" button (delegated to `<ReportClient>`).
  - _Proof: Manual — click the button; paste into a text editor; confirm the CAFC
    text block is present._

- [ ] `<ReportClient>` component exists at `app/reports/[id]/report-client.tsx`.
  - _Proof: File exists and exports a default component with clipboard and print
    buttons._

  > **Status:** `page.tsx` imports `ReportClient` from `./report-client` but that
  > file does not exist in the workspace yet.

- [x] The page includes a legal footer with the CAFC link and "nothing has been
  submitted automatically".
  - _Proof: Manual — scroll to the bottom of the report page._

---

## R10 — No auto-submission

- [x] No code path in `lib/report.ts`, `lib/alerts.ts`, or any route handler sends
  report data to an external service automatically.
  - _Proof: Code review — search the codebase for `fetch(` and `axios.post(` with
    external URLs in `lib/report.ts`; confirm none exist._

---

## R11 — Privacy

- [ ] `sendAlerts()` does not log full phone numbers to `console`.
  - _Proof: `tests/alerts.test.ts` — described in R6 above._

- [ ] `lib/report.ts` does not log full phone numbers or API keys.
  - _Proof: Code review and `tests/report.test.ts` — spy on console in the report
    builder; assert no E.164 strings appear._

---

## Extra tasks

- [ ] Create `app/reports/[id]/report-client.tsx` — client component with a
  clipboard "Copy for CAFC report" button and a print button.
  - _Proof: Manual — open the report page; click "Copy for CAFC report"; confirm
    clipboard contains the CAFC text block._

- [ ] Wire `sendAlerts()` and `buildAndStoreReport()` into
  `app/api/voice/status/route.ts` for MEDIUM/HIGH calls.
  - _Proof: `tests/voice-status.test.ts` — mock both functions; POST a completed
    HIGH call; assert both were called._

- [ ] Write `tests/alerts.test.ts` covering `buildAlertSms` truncation, checklist
  gating, idempotency, event logging, and phone-number privacy.
  - _Proof: `npx vitest run tests/alerts.test.ts` passes._

- [ ] Write `tests/report.test.ts` covering `buildCafcText` output, `guessScamType`
  for all categories, `extractSafeWordResult` with 0/1/2 attempt events, and
  idempotency.
  - _Proof: `npx vitest run tests/report.test.ts` passes._
