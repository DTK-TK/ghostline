 # Tasks: conversation-and-scoring

Status was checked by reading the code and imports, not from earlier notes.

Rule for `[x]`: the code fully does it AND an `app/api/voice/*` route reaches
it. `app/api/dev/phone/*` routes do not count, because they are not the live
call path. Everything else stays open. The earlier version of this file marked
many items done and cited test files that do not exist (`twiml`,
`scoring-*`, `conversation` tests). Those marks were removed.

Re-planned for the hackathon MVP due Dec 4, 2026. Every task is kept. Decisions are in design.md under "Re-plan decisions".

---

## MVP (build now)

Reason: Everything the Dec 4, 2026 demo needs: a real call through the real engine, safe word and callback checks, the alert and fraud report, and the dashboard to watch it.

- [x] **1. Wire `/api/voice/turn` to the real engine.**
  In `app/api/voice/turn/route.ts` import `engine` from `@/lib/conversation`
  (destructure the same `{ reply, nextState, riskUpdate }`). Delete
  `lib/conversation-engine.ts`. Update `tests/voice-turn.test.ts` to
  `vi.mock("@/lib/conversation")` and mock `engine`.
  - _Proof: `npx vitest run tests/voice-turn.test.ts` passes; `npx tsc --noEmit`
    shows no reference to `conversation-engine`; `Test-Path lib/conversation-engine.ts`
    is False; manual: call the dev phone with a gift-card script and see the reply
    differ from the old stub line "Thank you. Could you tell me more about why
    you're calling?"._
  - _MVP, build item 1: A real call must reach the real engine, not the stub._

- [x] **6. DB-backed silence count.** Replace `computeSilenceCount` in the
  turn route (empty speech in `screening` currently ends the call at once)
  with a count of consecutive empty caller transcripts in `call_events`.
  Move it out of the route file.
  - _Proof: `tests/voice-turn.test.ts`: one empty turn replies and keeps
    gathering; two consecutive empty turns hang up._
  - _MVP, build item 1: One silent turn must not hang up the caller._
  - _Re-plan: Decision: one empty turn replies and keeps gathering; hang up after two consecutive empty turns._

- [x] **9. Fallback on a missing key.** `getAI()` or `GeminiAI` failing for a
  missing `GEMINI_API_KEY` must lead to the rules-only fallback, not a
  rethrow. Catch it in `callGemini` and raise `AIUnavailableError`.
  - _Proof: `tests/conversation.test.ts`: unset key, `engine()` returns a
    non-empty reply and does not throw; `console.error` is called and the
    output contains no key._
  - _MVP, build item 1: A missing or failing Gemini key must fall back, not drop the call._

- [x] **11. Remove the opening line from the Gemini prompt**
  (`buildSystemPrompt` in `lib/providers/ai.ts`). The greeting is spoken by
  TwiML.
  - _Proof: `tests/scoring-ai.test.ts`: captured `systemInstruction` does not
    contain "This call is screened by Ghostline"._
  - _MVP, build item 1: The greeting is spoken by TwiML; the prompt must not repeat it._

- [x] **8. Persist Ghostline's replies** as `transcript` events with
  `speaker: "system"` inside `engine()`.
  - _Proof: `tests/conversation.test.ts`: after a turn, `appendEvent` is called
    with a system transcript; a second turn's history includes it._
  - _MVP, build item 2: The safe-word challenge phase is read from stored system replies._

- [x] **10. Reply guard.** Add `lib/scoring/reply-guard.ts` (`validateReply`)
  and use it in `engine()`: more than 2 sentences, 25 or more words,
  accusatory words, or a repeated opening line fall back to the scripted
  band line.
  - _Proof: `tests/reply-guard.test.ts` and a `tests/conversation.test.ts`
    case where the mocked Gemini returns a 40-word reply._
  - _MVP, build item 2: Enforces the voice rules (2 sentences, under 25 words, never accuse)._

- [x] **2. Pass `safeWordCorrect` and `callbackDenied` from `call_events`.**
  In `engine()`, set `safeWordCorrect` from any `safe_word_attempt` with
  `matched: true`, and `callbackDenied` from any `callback_result` with
  `outcome: "denied"`. Remove both hardcoded `false` values.
  - _Proof: `tests/conversation.test.ts`: events with a denied callback give
    level `high`, even with a matched safe word; a matched safe word alone on
    a 45-point transcript gives 5; no events gives the old behaviour._
  - _MVP, build item 6: Scoring must use the safe word and callback results._
  - _Re-plan: Needed by safe-word-and-callback task 7; the verified-state proof there finishes here._

- [x] **14. `safe_word_fail` points.** Add 50 per `safe_word_attempt` with
  `matched: false` to the rules score in `engine()`.
  - _Proof: `tests/conversation.test.ts`: two failed attempts add 100 and the
    level is `high`. Coordinate with the safe-word-and-callback spec, which
    writes the events._
  - _MVP, build item 5: Failed safe-word attempts must raise the score._

- [x] **12. Filter AI flags to the known ids** before scoring or writing
  `red_flag` events.
  - _Proof: `tests/scoring-ai.test.ts` and `tests/conversation.test.ts`: a
    mocked response with flag `"made_up"` produces no `red_flag` event._
  - _MVP, build item 8: Only known flag ids may become stored red-flag evidence._

- [x] **15. MEDIUM takes a message and alerts.** Implement R7 for MEDIUM
  (state `completed` with the message TwiML, and a `sendAlerts` call from the
  alerts-and-report spec). Settle the open decision in design.md first.
  - _Proof: `tests/conversation.test.ts`: a 40 to 69 score ends in message
    taking, not `screening`; manual: a gift-card-only call leaves a message
    and sends one SMS._
  - _MVP, build item 8: MEDIUM calls must take a message and alert the family._
  - _Re-plan: Decision: the MEDIUM alert is sent at message-taken or at call end, never twice. Open decision in design.md: the default of up to 3 caller turns before taking a message stays unless you say otherwise._

- [x] **3. Vitest mock for Gemini.**
  Add `tests/helpers/gemini.ts` that mocks `@google/genai` `GoogleGenAI`
  (`models.generateContent`): success JSON, invalid JSON, thrown error, slow
  response. Set a dummy `GEMINI_API_KEY` in the helper and call
  `vi.resetModules()` between cases (the `getAI()` singleton).
  - _Proof: with `GEMINI_API_KEY` and `AI_PROVIDER` unset and the network
    off, `npx vitest run` passes. A test spies on `fetch` and asserts zero
    calls._
  - _MVP, build item 10: Tests must run without network or a real Gemini key._

- [x] **4. 30 fixture transcripts in `tests/fixtures`.**
  `scams.json` (15: grandparent x3, CRA x3, bank x3, tech support x3,
  romance x3) and `legitimate.json` (15: doctor's office x3, pharmacy x3,
  delivery x3, real grandchild with safe word x3, neighbour x3). Each entry:
  `{ id, category, caller[], safeWordCorrect?, expectedLevel }`. Fake names
  only. Add `tests/fixtures.test.ts` that scores each one with `scoreRules` +
  `combineScores` (AI score 0).
  - _Proof: `npx vitest run tests/fixtures.test.ts` shows 30 cases. Any case
    the rules cannot meet is marked `knownGap` with a reason (see design.md),
    not edited to pass. The task report lists every `knownGap`._
  - _MVP, build item 10: The 30 fixtures also feed the simulator._

- [x] **5. Property-based tests with fast-check** in
  `tests/scoring-properties.test.ts`:
  (a) rules score is monotonic: appending utterances never lowers it;
  (b) a transcript containing a payment signal and an urgency signal scores
  at least 60 and is at least MEDIUM;
  (c) `callbackDenied: true` is always HIGH for any other inputs, including
  `safeWordCorrect: true`;
  (d) with `safeWordCorrect: false`, `combineScores` gives
  `score >= min(100, rulesScore)` for any `aiScore`, and a higher `aiScore`
  never produces a lower result.
  - _Proof: `npx vitest run tests/scoring-properties.test.ts` passes with at
    least 100 runs per property._
  - _MVP, build item 10: Property-based tests are a stated requirement._

- [ ] **16. Engine tests.** `tests/conversation.test.ts` with `lib/db`
  mocked: state transitions per band, terminal states, red-flag dedup,
  fallback, monotonic floor, `updateCall` fields.
  - _Proof: `npx vitest run tests/conversation.test.ts` passes._
  - _MVP, build item 10: Proves the engine on the live path._

- [ ] **17. Rules, combine and AI unit tests.** `tests/scoring-rules.test.ts`,
  `tests/scoring-combine.test.ts` (every R5 branch, 39/40/69/70, cap),
  `tests/scoring-ai.test.ts` (config has `responseMimeType` and an abort
  signal, zod failure, timeout).
  - _Proof: `npx vitest run tests/scoring-*.test.ts` passes._
  - _MVP, build item 10: Proves scoring, including every combineScores branch._
  - _Re-plan: Write the combine tests first; rules and AI unit tests can slip if time runs out._

---

## Deferred (post-hackathon)

Reason: Not needed to show the demo (the demo household is seeded with SQL), so these wait until after the hackathon.

- [ ] **7. Stop duplicating the latest utterance.** The route already stores
  the caller turn before `engine()`. Build `history` and the rules input from
  stored events excluding the current one, or stop re-adding `speechResult`.
  - _Proof: `tests/conversation.test.ts`: the prompt passed to the Gemini mock
    contains the latest utterance once._
  - _Deferred: Prompt duplication costs a few tokens only; re-check against the fixtures after the demo._

- [ ] **13. Widen the rules to every `scam-rules.md` signal** (bare "bank",
  "wire", "courier", "install") and narrow the false-positive-prone ones
  (`emergency`, `hospital`, `in trouble`) without losing the listed signals.
  - _Proof: `tests/scoring-rules.test.ts`: one case per listed signal; the 15
    legitimate fixtures stay below 40._
  - _Deferred: Fixtures record any rule gap as knownGap; widening the rules waits for that list._

---

## Requirement checklist (checked against the code)

_A requirement whose tasks are all deferred is deferred with them. Task placement is in the two sections above._

- [x] **R1** `greetingTwiml()` in `lib/twiml.ts` speaks the exact line
  (lines 43 to 45), called by `/api/voice/incoming`.
  - _Proof: `tests/voice-incoming.test.ts` asserts the opening text (passes in
    the current run)._
- [ ] **R1** The Gemini prompt does not repeat it. See task 11.
- [ ] **R2** Reply rules enforced in code. See task 10. The prompt contains
  the rules, but nothing checks the output.
- [ ] **R3** Rules table. `scoreRules` exists with correct weights but is
  reached only from the dev route and `MockAI`, and it misses listed signals.
  See task 13.
- [ ] **R3** `safe_word_fail`. See task 14.
- [ ] **R4** AI layer. Code exists in `lib/providers/ai.ts` (model, JSON mode,
  6 s abort, zod) but is not reached from a live route until task 1. Untested.
  See tasks 3, 9, 12, 17.
- [ ] **R5** `combineScores` is correct in code but is reached live only after
  task 1, and with hardcoded inputs until task 2. Untested. See tasks 2, 5, 17.
- [ ] **R6** Fallback. Implemented in `engine()` for `AIUnavailableError`
  only. Not live (task 1), missing-key case open (task 9).
- [ ] **R7** `computeNextState` exists. Not live (task 1). MEDIUM behaviour
  open (task 15).
- [ ] **R8** Red-flag dedup and call updates exist in `engine()`, not live.
  System replies not stored (task 8).
- [ ] **R9** History from `call_events` exists in `engine()`, not live.
  Duplicate utterance (task 7).
- [ ] **R10** 6 s abort exists in the provider. Engine total is unmeasured.
  - _Proof: manual: dev phone turn with a slow Gemini mock (7 s) returns the
    fallback reply in under 8 s._
- [ ] **R11** Test requirements. See tasks 3, 4, 5, 16, 17.
