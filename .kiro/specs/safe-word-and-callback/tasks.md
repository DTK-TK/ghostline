# Tasks — safe-word-and-callback

---

## R1 — Safe-word challenge trigger

- [ ] `engine()` in `lib/conversation.ts` detects `claims_family = true` from the AI
  response and transitions the call to the safe-word challenge phase, prompting
  the caller without revealing the word.
  - _Proof: `tests/safe-word.test.ts` — mock Gemini to return `claims_family: true`;
    assert `nextState = "screening"` and `reply` does not contain the safe word._

  > **Status:** `computeNextState()` keeps HIGH-family callers in `"screening"`,
  > but there is no code that generates the challenge prompt or routes the next
  > turn as a safe-word attempt. The challenge prompt logic is absent.

---

## R2 — Safe-word comparison

- [ ] Safe-word comparison uses bcrypt (`bcryptjs.compareSync`) against
  `households.safe_word_hash`, with the attempt normalised to lowercase + trimmed
  before comparison.
  - _Proof: `tests/safe-word.test.ts` — hash "pumpkin" with bcrypt cost 12; call
    the comparator with "PUMPKIN ", " pumpkin", and "wrong"; assert true/true/false._

  > **Status:** No bcrypt comparison code exists. The conversation engine does not
  > yet handle safe-word attempts.

---

## R3 — Safe-word success

- [ ] A correct safe word appends `safe_word_attempt` event with `matched = true`,
  applies the −40 score adjustment, and transitions to `"verified"`.
  - _Proof: `tests/safe-word.test.ts` — mock DB to return a hashed "pumpkin";
    supply "pumpkin" as speech; assert event appended with `matched=true`,
    `nextState="verified"`, and score reduced by 40 (floor 0)._

---

## R4 — Safe-word failure

- [ ] Each wrong attempt appends `safe_word_attempt` event with `matched = false`
  and adds 50 to the risk score via the `safe_word_fail` flag.
  - _Proof: `tests/safe-word.test.ts` — supply wrong word; assert event
    `matched=false` and score increases by 50._

- [ ] After two failures, the call moves to HIGH-risk state flow
  (`time_wasted` or `scam_blocked`).
  - _Proof: `tests/safe-word.test.ts` — two wrong attempts in sequence; assert
    `nextState` is `"time_wasted"` (TWE on) or `"scam_blocked"` (TWE off)._

---

## R5 — Safe word never revealed

- [ ] No code path produces a reply containing the safe word or a "close" hint.
  - _Proof: `tests/safe-word.test.ts` — for every reply string returned by the
    engine during a safe-word phase, assert it does not equal, include, or
    reference `households.safe_word_hash` or the plaintext word._

  > **Status:** The Gemini system prompt includes "Never reveal, hint at, or
  > repeat the safe word" but there is no post-generation assertion in code.
  > Task is open until a reply guard is implemented or the test formally covers it.

---

## R6 — Callback initiation

- [ ] When `claims_family = true` and a callback target exists, `engine()` initiates
  an outbound call via the Twilio REST API, appending `callback_started` first.
  - _Proof: `tests/callback.test.ts` — mock `getCallbackTargets` to return one
    member; mock `twilio.calls.create`; assert it is called once with the correct
    `to`, `from`, and `url` params, and a `callback_started` event is in the DB._

  > **Status:** No outbound callback code exists. `app/api/voice/callback/` route
  > does not exist.

- [ ] `app/api/voice/callback/route.ts` returns TwiML asking the family member to
  press 1 to confirm or 2 to deny.
  - _Proof: `tests/callback.test.ts` — POST to the route with a valid Twilio
    signature; assert `<Gather numDigits="1">` in the response body._

- [ ] `app/api/voice/callback/result/route.ts` handles the DTMF digit:
  - Digit 1 → `callback_result` event `outcome="confirmed"`.
  - Digit 2 → `callback_result` event `outcome="denied"` + +100 score.
  - Timeout → `callback_result` event `outcome="no_answer"`.
  - _Proof: `tests/callback.test.ts` — POST with `Digits=1`, `Digits=2`, and no
    digit; assert the correct event and score for each._

---

## R7 — Callback denied

- [ ] When callback result is `"denied"`, the original screening call's risk score
  is updated with +100 and the state transitions to `scam_blocked` (or
  `time_wasted`).
  - _Proof: `tests/callback.test.ts` — deny callback; look up the original call's
    DB row; assert `risk_score >= 70` and `state` is a terminal HIGH state._

---

## R8 — Callback confirmed

- [ ] When callback result is `"confirmed"`, no score change is applied and the
  call may proceed to `"verified"`.
  - _Proof: `tests/callback.test.ts` — confirm callback; assert score unchanged,
    state can transition to `"verified"`._

---

## R9 — `callback_denied` is irreversible

- [x] `combineScores()` applies `callback_denied += 100` before the safe-word
  credit, so a correct safe word cannot cancel a denial.
  - _Proof: `tests/scoring-combine.test.ts` — `callbackDenied=true`,
    `safeWordCorrect=true`, base=0 → final score 60 (not 0)._

---

## R10 — Privacy of phone numbers

- [ ] No `console.log` or `console.error` call in `lib/alerts.ts`,
  `lib/conversation.ts`, or the callback routes outputs a full phone number.
  - _Proof: `tests/alerts.test.ts` — spy on `console.log`; call `sendAlerts()`
    with a real E.164 number; assert no log line contains the full number string._

---

## Extra tasks

- [ ] Add `bcryptjs` (or `bcrypt`) dependency and write `lib/safe-word.ts` with
  `checkSafeWord(attempt, hash): boolean` using normalise + bcrypt compare.
  - _Proof: `tests/safe-word.test.ts` — unit tests with known hash._

- [ ] Implement safe-word phase detection in `engine()`: count `safe_word_attempt`
  events to determine whether to issue the challenge prompt or evaluate an attempt.
  - _Proof: `tests/safe-word.test.ts` — two-turn sequence: first turn sees
    `claims_family=true` → challenge prompt issued; second turn has word → compared._

- [ ] Create `app/api/voice/callback/route.ts` and
  `app/api/voice/callback/result/route.ts` with Twilio signature validation.
  - _Proof: `tests/callback.test.ts` and manual test: initiate a simulator call
    with `claims_family=true`; verify callback rings the target number._

- [ ] Write `tests/safe-word.test.ts` covering normalisation, bcrypt comparison,
  success/failure score arithmetic, and two-failure escalation.
  - _Proof: `npx vitest run tests/safe-word.test.ts` passes._

- [ ] Write `tests/callback.test.ts` covering all three DTMF outcomes, the
  initiation guard (no double-dial), and the denied score update on the original call.
  - _Proof: `npx vitest run tests/callback.test.ts` passes._
