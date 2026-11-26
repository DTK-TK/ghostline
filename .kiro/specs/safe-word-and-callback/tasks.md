# Tasks: safe-word-and-callback

Status was checked by reading the code and imports, not from earlier notes.

Rule for `[x]`: the code fully does it AND an `app/api/voice/*` route reaches
it. `app/api/dev/phone/*` does not count. Nothing in the safe-word or callback
behaviour meets that bar today, so only a documentation task is checked.
The previous version of this file checked R9 (`combineScores` order) and cited
a proof that does not exist and a wrong expected value (60). The code returns
at least 100 for a denied callback, and no live route passes `callbackDenied`.

What exists but is not wired: `households.safe_word_hash` and the demo seed,
`family_members.is_callback_target` and `getCallbackTargets()`, the event types
`safe_word_attempt`, `callback_started`, `callback_result`,
`TelephonyProvider.startCallbackCall` (Twilio and Mock), `combineScores`
(denied and safe-word branches), `bcryptjs` in `package.json`, the report and
alert text that reads these results, and the dev-only
`/api/dev/phone/callback-answer`.

---

## Open tasks, in priority order

- [ ] **1. Build `POST /api/voice/hold-check` and `POST /api/voice/callback-result`.**
  Both call `validateTwilioRequest` (403 on failure), keep logic in
  `lib/callback.ts`, and return safe TwiML on error.
  `callback-result` handles `Digits` (1 = `denied`, 2 = `confirmed`) and
  status callbacks (no-answer, busy, failed, canceled, completed without a
  digit = `no_answer`), writes one `callback_result` event (first result wins),
  rescores, and sets the HIGH state on denial. `hold-check` reads `?n=` (1 to
  4), returns `Pause 10` + `Redirect` while pending, and records `no_answer`
  at n = 4.
  - _Proof: tasks 2 and 3 below; manual: dev phone with a gift-card + "I'm your
    grandson Sam" script, answer the callback with 1 and see the caller get the
    blocked or time-waster reply within one hold loop._

- [ ] **2. Tests for both routes, reusing `tests/helpers/voice.ts`.**
  `tests/voice-callback-result.test.ts` and `tests/voice-hold-check.test.ts`,
  mocking `@/lib/db` with `vi.hoisted` like `tests/voice-turn.test.ts`, using
  `twilioRequest`, `parseTwiml`, `householdFixture`, `callFixture`.
  Cases: bad signature gives 403; `Digits=1` writes `denied`; `Digits=2` writes
  `confirmed`; status `no-answer` and `busy` write `no_answer`; a second
  request does not write a second result; hold-check n=1..3 returns
  `Pause` + `Redirect` with the next `n`; n=4 writes `no_answer`; denied result
  returns block or time-waster TwiML; DB error returns safe TwiML.
  - _Proof: `npx vitest run tests/voice-callback-result.test.ts tests/voice-hold-check.test.ts` passes._

- [ ] **3. Scoring tests.** In `tests/safe-word.test.ts`,
  `tests/callback.test.ts` and `tests/scoring-combine.test.ts`:
  (a) a correct safe word lowers the score by exactly 40 (e.g. 45 to 5, 30 to 0),
  including a multi-turn case where the stored score is already 45;
  (b) a denied callback forces HIGH for any prior score and any
  `safeWordCorrect`;
  (c) `no_answer` leaves score and state unchanged.
  - _Proof: `npx vitest run tests/safe-word.test.ts tests/callback.test.ts tests/scoring-combine.test.ts`
    passes. Case (a), multi-turn, fails until task 5 lands._

- [x] **4a. Note in design.md on bcryptjs vs pgcrypto hash compatibility.**
  Written (section "Hash compatibility: bcryptjs and pgcrypto"). Facts checked:
  bcryptjs 3 verifies `$2b$`, `$2a$` and `$2y$`; pgcrypto emits `$2a$`.
  - _Proof: read that section of design.md._
- [ ] **4b. Prove it against the real seed.** Add a test that bcryptjs
  verifies the same hash under the `$2a$`, `$2b$` and `$2y$` prefixes. Run the
  seed on Supabase and confirm `left(safe_word_hash, 4)` and a successful
  "pumpkin" on the dev phone.
  - _Proof: test in `tests/safe-word.test.ts`; manual check noted in the PR._

---

## Further open tasks

- [ ] **5. Fix `combineScores`.** Add `callbackConfirmed` (-40, floor 0, ignored
  when denied). Apply the floor to the gross score and credits after it, as in
  design.md. Coordinate with conversation-and-scoring, which owns the file.
  - _Proof: `tests/scoring-combine.test.ts` cases listed in task 3; property:
    `callbackDenied` is always HIGH._

- [ ] **6. `lib/safe-word.ts`.** `normalise`, `stripLeadIn`, `checkSafeWord`
  with `bcryptjs`. Max 2 compares per attempt, invalid hash returns false and
  logs without the hash.
  - _Proof: `tests/safe-word.test.ts` with a real cost-4 hash: "PUMPKIN ",
    "Pumpkin!", "pumpkins", "it's pumpkin" match; "pumpkin pie", "pump" do not._

- [ ] **7. Engine: challenge and attempts.** Ask "What's the family word?" on a
  family claim, detect the challenge phase from the last system transcript,
  redact the attempt (event `attempt: "[redacted]"`, transcript "[safe word
  attempt]", nothing sent to Gemini or the rules layer), apply -40 / +50, move
  to `verified` or the HIGH flow. Requires conversation-and-scoring tasks 1, 2,
  8 and 14.
  - _Proof: `tests/safe-word.test.ts`: correct word gives `verified`; two wrong
    words give `time_wasted` (TWE on) or `scam_blocked` (TWE off); the Gemini
    mock is not called on the attempt turn; no stored event or reply contains
    the word._

- [ ] **8. Redact before the transcript write.** Adjust
  `app/api/voice/turn/route.ts` (or move the write into the engine) so the
  safe-word turn is never stored as plaintext.
  - _Proof: `tests/voice-turn.test.ts`: during the challenge, `appendEvent` is
    never called with the spoken word._

- [ ] **9. Deterministic family-claim fallback.** When the AI is unavailable,
  detect "grandson", "granddaughter", "it's me", "your son/daughter" and
  similar by pattern so the challenge still happens.
  - _Proof: `tests/conversation.test.ts`: Gemini mock throws, caller says
    "Grandma it's me, I need help"; the reply is the challenge._

- [ ] **10. `lib/callback.ts` and callback start.** `startCallback` (guard:
  once per call, needs a target and a clean name), `recordCallbackResult`,
  `holdDecision`, `maskPhone`. Start the callback from the engine and return
  hold TwiML (`Say` + `Pause 10` + `Redirect hold-check?n=1`).
  - _Proof: `tests/callback.test.ts`: one `callback_started`, one
    `startCallbackCall` with the sanitised name; second claim does not redial;
    no target or provider error gives `no_answer`._

- [ ] **11. `POST /api/voice/callback`** (answer webhook) with the exact
  prompt text and `Gather numDigits=1`, `claimedName` sanitised. Repoint
  `statusCallback` in `TwilioTelephony.startCallbackCall` to
  `/api/voice/callback-result`.
  - _Proof: `tests/voice-callback.test.ts`: XML contains the exact sentence
    and `numDigits="1"`; name with markup or over 40 characters is cleaned;
    403 without a valid signature._

- [ ] **12. Align the dev harness.** In `/api/dev/phone/callback-answer` and
  `phone-client.tsx`: 1 = denied, 2 = confirmed, reuse `recordCallbackResult`,
  fix the `callId`/`callSid` header comment.
  - _Proof: manual: dev phone buttons match the spoken prompt; a confirmed
    answer lowers the score by 40._

- [ ] **13. Phone number privacy.** Remove full numbers from `MockTelephony`
  `console.log` output (use `maskPhone`). Never log the hash or attempts.
  - _Proof: `tests/callback.test.ts`: spy on `console.log` and `console.error`
    while starting a callback with a real-looking number; no call contains it._

- [ ] **14. Settings uses `normalise`.** The Settings page (dashboard spec)
  must hash the normalised word with `bcryptjs`. Add a unit test of the helper
  that the Settings code will call.
  - _Proof: `tests/safe-word.test.ts`: `hashSafeWord("Pumpkins!")` verifies
    against "pumpkin"._

- [ ] **15. Alerts on denial.** A denied result triggers the family alert and
  report through the alerts-and-report spec.
  - _Proof: `tests/voice-callback-result.test.ts`: the alert function is called
    once on `denied` and not on `confirmed` or `no_answer`._

---

## Requirement checklist (checked against the code)

- [ ] **R1** Challenge and prompt. No code. See tasks 7, 9.
- [ ] **R2** Normalisation. No code. See task 6.
- [ ] **R3** Comparison. No `lib/safe-word.ts`; nothing imports `bcryptjs`. Tasks 4b, 6.
- [ ] **R4** Success. No code. Tasks 5, 7.
- [ ] **R5** Failure. No code; `safe_word_fail` points not implemented. Task 7.
- [ ] **R6** Never exposed. Raw speech is stored and sent to Gemini today. Tasks 7, 8.
- [ ] **R7** Callback initiation. Provider method exists, never called. Tasks 10, 11.
- [ ] **R8** Results. Only a dev route, with reversed digits. Tasks 1, 5, 12.
- [ ] **R9** Hold loop. No route. Task 1.
- [ ] **R10** Webhook rules. The new routes do not exist. Tasks 1, 2, 11.
- [ ] **R11** Score interaction. Hardcoded `false`; floor cancels credits. Tasks 5, 7.
- [ ] **R12** Privacy. `MockTelephony` logs full numbers. Task 13.
- [ ] **R13** Verification. No tests for any of this. Tasks 2, 3, 4b.
