# Tasks — conversation-and-scoring

---

## R1 — Opening line

- [x] `greetingTwiml()` in `lib/twiml.ts` speaks the exact required opening line
  including `{family_name}`.
  - _Proof: `tests/twiml.test.ts` — verify `greetingTwiml("Sun", baseUrl)` XML
    contains the verbatim string._

---

## R2 — Persona constraints

- [ ] `lib/scoring/ai.ts` system prompt enforces all persona rules: ≤ 2 sentences,
  ≤ 25 words, never accuses, uses "I'm not able to connect this call." to decline,
  never reveals the safe word, never gives household info.
  - _Proof: `tests/scoring-ai.test.ts` — send a canned caller transcript that
    should trigger a refusal; assert `reply` does not contain "scam", "fraud",
    or the safe word, and is ≤ 25 words._

  > **Status:** `buildSystemPrompt()` exists and includes persona rules, but the
  > word-count and safe-word constraints are prompt instructions only — there is no
  > post-generation enforcement in code. Task is open until a reply validator is
  > added or the test formally covers it.

---

## R3 — Rules-layer scoring

- [x] `lib/scoring/rules.ts` exports `scoreRules(transcript: string[]): RulesResult`
  with all six flag IDs and correct point values from scam-rules.md.
  - _Proof: `tests/scoring-rules.test.ts` — property-based tests confirm each
    keyword triggers the right flag and score._

- [x] Each flag fires at most once per call regardless of repetition.
  - _Proof: `tests/scoring-rules.test.ts` — repeat the same keyword 10× in the
    transcript array; assert score equals single-flag weight._

---

## R4 — AI-layer scoring

- [x] `lib/scoring/ai.ts` calls `gemini-2.5-flash` via `@google/genai` with
  `responseMimeType = "application/json"` and a 6-second `AbortSignal.timeout`.
  - _Proof: `tests/scoring-ai.test.ts` — mock `GoogleGenAI`; assert the config
    object contains `responseMimeType` and the timeout signal._

- [x] Response is validated with `GeminiResponseSchema` (Zod); all required fields
  present (`reply`, `risk_score`, `flags`, `claimed_identity`, `claims_family`,
  `requested_amount`, `payment_method`, `summary`).
  - _Proof: `tests/scoring-ai.test.ts` — supply a response missing one field;
    assert `GeminiUnavailableError` is thrown._

- [x] `GeminiUnavailableError` is thrown on timeout, network error, or Zod failure.
  - _Proof: `tests/scoring-ai.test.ts` — mock a timeout; assert the error class._

---

## R5 — Score combination

- [x] `combineScores()` takes `max(rulesScore, aiScore)` as the base.
  - _Proof: `tests/scoring-combine.test.ts` — rulesScore=30, aiScore=50 → base=50._

- [x] `callback_denied` adds 100, applied before safe-word credit.
  - _Proof: `tests/scoring-combine.test.ts` — callbackDenied=true, safeWordCorrect=true,
    base=0 → 100 − 40 = 60 (not 0); final = max(60, prior)._

- [x] Correct safe word subtracts 40, floor 0, only when `callbackDenied = false`.
  - _Proof: `tests/scoring-combine.test.ts` — base=30, safeWordCorrect=true → 0;
    base=30, safeWordCorrect=true, callbackDenied=true → 100 (no subtraction)._

- [x] Score is monotonically non-decreasing (prior score floor).
  - _Proof: `tests/scoring-combine.test.ts` — new combined=10, priorScore=50 → 50._

- [x] Score is capped at 100.
  - _Proof: `tests/scoring-combine.test.ts` — callbackDenied=true, base=80 → 100._

- [x] Risk bands: LOW 0–39, MEDIUM 40–69, HIGH ≥ 70.
  - _Proof: `tests/scoring-combine.test.ts` — spot-check boundary values 39, 40, 69, 70._

---

## R6 — Gemini fallback

- [x] `lib/conversation.ts` catches `GeminiUnavailableError`, logs via
  `console.error`, and continues with rules-only scoring and a scripted reply.
  - _Proof: `tests/conversation.test.ts` — mock `callGemini` to throw
    `GeminiUnavailableError`; assert call does not throw, `reply` is a non-empty
    string, and `nextState` is set._

- [ ] Fallback reply for HIGH risk is `"I'm not able to connect this call. Goodbye."`
  (not generic medium text).
  - _Proof: `tests/conversation.test.ts` — mock rules to return score 70+,
    Gemini unavailable; assert `reply` matches the HIGH fallback string._

  > **Status:** `FALLBACK_REPLIES` exists with the HIGH string, but the time-waster
  > path uses the same string rather than a grandmother line. See time-waster spec.

---

## R7 — State transitions

- [x] `computeNextState()` returns `"time_wasted"` when HIGH + TWE on.
  - _Proof: `tests/conversation.test.ts` — level="high", timeWasterEnabled=true →
    nextState="time_wasted"._

- [x] `computeNextState()` returns `"scam_blocked"` when HIGH + TWE off.
  - _Proof: `tests/conversation.test.ts` — level="high", timeWasterEnabled=false →
    nextState="scam_blocked"._

- [x] `computeNextState()` keeps `"screening"` for MEDIUM.
  - _Proof: `tests/conversation.test.ts`._

- [x] `computeNextState()` returns `"verified"` for LOW + no family claim.
  - _Proof: `tests/conversation.test.ts`._

- [x] `computeNextState()` keeps `"screening"` for LOW + claims family.
  - _Proof: `tests/conversation.test.ts`._

- [x] Terminal states do not transition.
  - _Proof: `tests/conversation.test.ts` — input state="scam_blocked" → still
    "scam_blocked" regardless of score._

---

## R8 — Event persistence

- [x] `lib/conversation.ts` appends a `red_flag` event for each newly detected flag.
  - _Proof: `tests/conversation.test.ts` — first turn triggers `payment_method`;
    assert one `red_flag` event appended._

- [x] Already-recorded flags are not duplicated across turns.
  - _Proof: `tests/conversation.test.ts` — second turn has same keyword; assert
    no second `red_flag` event for the same flag_id._

- [x] `calls.risk_score`, `risk_level`, `claimed_identity`, `summary` updated after
  each turn.
  - _Proof: `tests/conversation.test.ts` — mock `updateCall`; assert it is called
    with the correct fields._

---

## R9 — Conversation state from DB

- [x] `engine()` loads full conversation history from `call_events` via
  `getCallEvents(call.id)`. No module-level state used.
  - _Proof: `tests/conversation.test.ts` — instantiate two separate engine calls
    with the same CallSid (simulating two serverless invocations); second call
    sees events from the first._

---

## R10 — 10-second budget

- [x] Gemini call uses `AbortSignal.timeout(6000)`.
  - _Proof: `tests/scoring-ai.test.ts` — inspect `config.abortSignal`._

- [ ] `runTurn()` in `lib/conversation-engine.ts` is wired to `engine()` from
  `lib/conversation.ts` (the stub is still the active export).
  - _Proof: `tests/conversation.test.ts` — import `runTurn` from
    `lib/conversation-engine`; call it with a real input; assert `reply` is not
    the stub string "Thank you. Could you tell me more about why you're calling?"_

---

## Extra tasks

- [ ] Write `tests/scoring-rules.test.ts` with property-based (fast-check) tests
  covering every flag keyword and boundary (no false positives on clean speech).
  - _Proof: `npx vitest run tests/scoring-rules.test.ts` passes._

- [ ] Write `tests/scoring-combine.test.ts` covering all six adjustment branches,
  boundary scores 39/40/69/70, monotonic floor, and DB cap.
  - _Proof: `npx vitest run tests/scoring-combine.test.ts` passes._

- [ ] Write `tests/scoring-ai.test.ts` with a mocked `GoogleGenAI`; cover happy
  path, timeout, missing fields, and wrong types in the JSON response.
  - _Proof: `npx vitest run tests/scoring-ai.test.ts` passes._

- [ ] Write `tests/conversation.test.ts` covering full engine turns: state
  transitions for each risk band, red-flag deduplication, Gemini fallback, and
  the monotonic score floor.
  - _Proof: `npx vitest run tests/conversation.test.ts` passes._

- [ ] Wire `lib/conversation-engine.ts` to re-export `engine` as `runTurn` from
  `lib/conversation.ts`, preserving the existing import in `turn/route.ts`.
  - _Proof: end-to-end manual test: call the demo number with a gift-card script;
    confirm the state transitions to `time_wasted` or `scam_blocked`._
