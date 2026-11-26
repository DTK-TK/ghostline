# Tasks — time-waster

---

## R1 — Activation condition

- [x] `computeNextState()` in `lib/conversation.ts` returns `"time_wasted"` when
  `level === "high"` and `timeWasterEnabled === true`.
  - _Proof: `tests/time-waster.test.ts` — level="high", TWE=true, state="screening"
    → "time_wasted"._

- [x] `computeNextState()` returns `"scam_blocked"` when `level === "high"` and
  `timeWasterEnabled === false`.
  - _Proof: `tests/time-waster.test.ts` — level="high", TWE=false → "scam_blocked"._

- [x] Terminal states do not re-enter `time_wasted`.
  - _Proof: `tests/time-waster.test.ts` — state="scam_blocked", level="high",
    TWE=true → still "scam_blocked"._

---

## R2 — Persona description

- [ ] When in `time_wasted` state, the Gemini system prompt includes the grandmother
  persona instructions (mishears, glasses, cat named Marmalade).
  - _Proof: `tests/time-waster.test.ts` — spy on `callGemini`; call engine with
    `currentState="time_wasted"`; assert the system prompt string contains
    "glasses" and "cat"._

  > **Status:** `buildSystemPrompt()` in `lib/scoring/ai.ts` has a brief
  > "TIME-WASTER MODE" section in the persona rules but does not receive
  > `currentState` as a parameter, so it cannot conditionally include the full
  > grandmother instructions. Task is open.

---

## R3 — Maximum duration (3 minutes)

- [ ] The engine tracks time in `time_wasted` state via the `state_change` event
  timestamp (no in-memory state).
  - _Proof: `tests/time-waster.test.ts` — insert a `state_change` event with
    `to="time_wasted"` dated 181 seconds ago; call engine; assert
    `nextState !== "time_wasted"` (transitions to "scam_blocked")._

- [ ] When 180 seconds have elapsed, `computeNextState` returns `"scam_blocked"`,
  and the turn route returns `blockTwiml()`.
  - _Proof: `tests/time-waster.test.ts` — same as above; also assert the returned
    TwiML contains `<Hangup`._

---

## R4 — TwiML for time-waster turns

- [x] `timeWasteTwiml(line, baseUrl)` exists in `lib/twiml.ts` and produces a
  `<Gather>` + `<Redirect>` pair (identical to `replyTwiml`).
  - _Proof: `tests/twiml.test.ts` — assert `timeWasteTwiml("line", base)` XML
    contains `<Gather` and `<Redirect`._

- [x] `buildTwiml()` in `app/api/voice/turn/route.ts` routes `"time_wasted"` to
  `timeWasteTwiml()`.
  - _Proof: `tests/voice-turn.test.ts` — mock `runTurn` to return
    `nextState="time_wasted"`; assert response body contains `<Gather`._

---

## R5 — State transition

- [x] Entering `time_wasted` appends a `state_change` event (handled by the turn
  route's standard transition logic).
  - _Proof: `tests/voice-turn.test.ts` — mock engine returning
    `nextState="time_wasted"` on a call in "screening"; assert `appendEvent` was
    called with `type="state_change"`, `to="time_wasted"`._

---

## R6 — Gemini prompt for time-waster mode

- [ ] `buildSystemPrompt()` accepts context (or `callGemini()` accepts a flag) so
  that when `currentState === "time_wasted"` the prompt includes the full
  grandmother persona block.
  - _Proof: `tests/time-waster.test.ts` — call `buildSystemPrompt` with
    `inTimeWaster=true`; assert returned string includes "Marmalade" and "glasses"
    and "3 minutes"._

  > **Status:** `buildSystemPrompt(familyName)` takes only `familyName`. It needs
  > an `inTimeWaster` parameter. `engine()` needs to pass it based on
  > `currentState`.

---

## R7 — Fallback during time-waster

- [ ] When Gemini is unavailable and `currentState === "time_wasted"`, the engine
  uses a scripted grandmother line, not the generic HIGH fallback.
  - _Proof: `tests/time-waster.test.ts` — mock `callGemini` to throw; set
    `currentState="time_wasted"`; assert `reply` is one of the grandmother fallback
    strings (contains "glasses" or "Marmalade" or "cat"), NOT
    "I'm not able to connect this call. Goodbye."_

  > **Status:** `FALLBACK_REPLIES` in `lib/conversation.ts` has only three keys
  > (`low`, `medium`, `high`). There is no `time_wasted` key or grandmother lines.

---

## R8 — Household toggle

- [ ] Dashboard settings page exposes a `<Switch>` for `time_waster_enabled` that
  persists the change to Supabase.
  - _Proof: Manual — open `/settings`; toggle the switch; reload the page; confirm
    the toggle state is preserved. Also: `tests/settings.test.ts` — PATCH
    `/api/settings/household` with `time_waster_enabled: false`; query DB; assert
    value is false._

---

## R9 — No accusation

- [ ] All grandmother fallback lines and the time-waster Gemini prompt instructions
  contain no accusatory language ("scam", "fraud", "police", "report").
  - _Proof: `tests/time-waster.test.ts` — iterate every string in
    `GRANDMOTHER_FALLBACKS`; assert none matches `/scam|fraud|police|report/i`._

---

## Extra tasks

- [ ] Add `inTimeWaster: boolean` parameter to `buildSystemPrompt()` and pass the
  full grandmother persona block when `true`. Update `engine()` to pass
  `currentState === "time_wasted"` as the flag.
  - _Proof: `tests/time-waster.test.ts` — prompt string test described in R6._

- [ ] Add grandmother fallback lines to `lib/conversation.ts` and select them by
  turn index when `currentState === "time_wasted"` and Gemini is unavailable.
  - _Proof: `tests/time-waster.test.ts` — fallback test described in R7._

- [ ] Implement the 3-minute timer in `engine()` using the `state_change` event
  timestamp.
  - _Proof: `tests/time-waster.test.ts` — timer tests described in R3._

- [ ] Write `tests/time-waster.test.ts` covering activation, timer, Gemini prompt
  content, fallback lines, and no-accusation assertion.
  - _Proof: `npx vitest run tests/time-waster.test.ts` passes._
