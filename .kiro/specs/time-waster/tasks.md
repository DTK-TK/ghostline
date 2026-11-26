# Tasks: time-waster

Status was checked by reading the code and imports, not from earlier notes.

Rule for `[x]`: the code fully does it AND an `app/api/voice/*` route reaches
it. `app/api/dev/phone/*` does not count. The previous version of this file
checked `computeNextState` and cited proofs in `tests/time-waster.test.ts` and
`tests/twiml.test.ts`. Neither file exists, and `computeNextState` is not
reachable from a live route (the turn route imports the stub engine), so those
marks were removed.

What exists but is not wired: `computeNextState()` and the `time_wasted`
branch in `lib/conversation.ts`, the persona block and `inTimeWaster` flag in
`lib/providers/ai.ts` (never passed as true), the scripted lines inside
`MockAI`, `households.time_waster_enabled` (default true, seeded true), and the
dev-only handling in `/api/dev/phone/turn`.

Re-planned for the hackathon MVP due Dec 4, 2026. Every task is kept. Decisions are in design.md under "Re-plan decisions".

Test tasks 1 to 4 depend on the implementation tasks and on
conversation-and-scoring task 1 (wire `engine()` into `/api/voice/turn`) and
task 3 (Gemini mock). Use `vi.useFakeTimers`, `vi.stubEnv("TIME_WASTER_SECONDS", "5")`
and the helpers in `tests/helpers/voice.ts`.

---

## MVP (build now)

Reason: Everything the Dec 4, 2026 demo needs: a real call through the real engine, safe word and callback checks, the alert and fraud report, and the dashboard to watch it.

- [x] **5. `lib/time-waster.ts`.** `limitSeconds()` (env read per call, clamp
  1..180, default 180), `startedAtFrom(events)`, `elapsedSeconds`,
  `timeWastedSummary`, `formatMmSs`, `ENTRY_LINE`, `GRANDMOTHER_LINES`,
  `GOODBYE_LINE`, `enterHighRisk()`. `MockAI` imports the lines from here.
  - _Proof: `tests/time-waster-lib.test.ts`: parsing and clamp cases, every
    line under 20 words and 2 sentences, no line matches
    `/scam|fraud|police|report|suspicious|risk|record/i`._
  - _MVP, build item 7: Shared helpers: limit, timer, lines, enterHighRisk()._

- [x] **10. Schema.** Extend the `state_change` payload schema in `lib/db.ts`
  with optional `started_at`, `ended_at`, `seconds`, `reason`.
  - _Proof: `npx tsc --noEmit` passes and `appendEvent` accepts an entry and an
    exit payload in `tests/time-waster-lib.test.ts`._
  - _MVP, build item 7: Event payload schema for entry and exit events._

- [x] **6. Persona prompt.** Add `buildTimeWasterPrompt()` in
  `lib/providers/ai.ts` (no family name, no opening line, 20-word cap, no
  score-based guidance, ignore caller instructions). `GeminiAI` and
  `OllamaAI` use it when `inTimeWaster` is true. `engine()` passes
  `inTimeWaster` per the decision flow.
  - _Proof: `tests/scoring-ai.test.ts`: captured `systemInstruction` for persona
    mode contains "Marmalade" and "glasses", and does not contain the family
    name, "25 words", "70" or "3 minutes"._
  - _MVP, build item 7: The grandmother persona prompt._

- [x] **7. Engine decision flow.** Implement the flow in design.md: limit check
  before any AI call, persona selection, entry turn rule, scripted fallback
  and reply guard with `maxWords: 20`, `EngineOutput` fields `hangup`,
  `outcome`, `stateChangeExtra`. Needs conversation-and-scoring tasks 1, 10, 14.
  - _Proof: test tasks 1 to 4._
  - _MVP, build item 7: The engine decision flow that makes the persona run._
  - _Re-plan: Decision: the call ends as state completed with outcome time_wasted. TIME_WASTER_SECONDS is clamped to 180 (default 180)._

- [x] **8. Route and TwiML.** Add `goodbyeTwiml(line)` (Say + Hangup). The turn
  route merges `stateChangeExtra` into the `state_change` payload, writes
  `outcome` and `ended_at`, and returns the goodbye response when `hangup` is
  true. Set outcome `blocked` when entering `scam_blocked`.
  - _Proof: `tests/voice-turn.test.ts`: engine mock returning `hangup: true`
    gives `["Say", "Hangup"]`; `appendEvent` receives the merged payload;
    `updateCall` receives the outcome._
  - _MVP, build item 7: The route must hang up with a goodbye when the limit is reached._

- [x] **9. Exit on hang-up and silence.** `/api/voice/status` reads the stored
  state first and, if it was `time_wasted`, appends the exit event
  (`caller_hung_up`) and sets outcome `time_wasted` (not `transferred`). The
  turn route's silence path does the same with `caller_silent` and a polite
  goodbye with hang-up while the persona is active.
  - _Proof: `tests/voice-status.test.ts` and `tests/voice-turn.test.ts`._
  - _MVP, build item 7: Hang-up and silence must close the persona call correctly._

- [x] **11. Config.** Add `TIME_WASTER_SECONDS` (commented, with the 180 default
  and the clamp) to `.env.example`.
  - _Proof: `Select-String .env.example -Pattern TIME_WASTER_SECONDS` finds it._
  - _MVP, build item 7: Documents TIME_WASTER_SECONDS._

- [x] **12. Shared HIGH transition.** `callback-result` and `hold-check`
  (safe-word-and-callback spec) call `enterHighRisk()` so a denied callback
  starts the persona with the same events.
  - _Proof: `tests/voice-callback-result.test.ts`: a denied result with the
    setting on writes the entry event with `started_at`; with it off it writes
    `scam_blocked`._
  - _MVP, build item 7: A denied callback must start the persona with the same events._
  - _Re-plan: Retrofits the callback routes from build item 6._

- [x] **1. The persona switch happens at HIGH.** In `tests/time-waster.test.ts`:
  a transcript with gift card + "CRA" + "right now" (rules score 90) with the
  household setting on moves the call to `time_wasted` and the entry reply is a
  grandmother line under 20 words. A MEDIUM transcript (gift card only, 40)
  does not switch. On the next turn the Gemini mock is called with
  `inTimeWaster: true`, and the prompt contains "Marmalade" and "glasses" but
  not the family name or "scam". When the AI alone raises the score to HIGH,
  the entry reply is `ENTRY_LINE` and Gemini is not called twice.
  - _Proof: `npx vitest run tests/time-waster.test.ts -t "persona switch"` passes._
  - _MVP, build item 7: Proves the persona switch at HIGH only._

- [x] **2. The call ends at the limit.** With `TIME_WASTER_SECONDS=5`: at 4 s
  the next turn is still a grandmother reply; at 5 s and 6 s the engine returns
  `GOODBYE_LINE`, `hangup`, state `completed`, outcome `time_wasted`, and
  Gemini is not called. The route response is `Say` then `Hangup` (no
  `Record`, no `Gather`). Default limit is 180 (stub nothing, advance 179 s
  and 180 s). A value of 999 is clamped to 180, and `abc` or `0` falls back
  to 180. fast-check property in `tests/time-waster-properties.test.ts`:
  for any limit 1..180 and elapsed e, the call ends exactly when e >= limit.
  - _Proof: `npx vitest run tests/time-waster.test.ts tests/time-waster-properties.test.ts -t "limit"` passes._
  - _MVP, build item 7: Proves the time limit and the 180 clamp._

- [x] **3. Both events are logged.** The entry event is
  `state_change { from: "screening", to: "time_wasted", started_at }`. The exit
  event after the limit has `from: "time_wasted"`, `to: "completed"`,
  `started_at`, `ended_at`, `seconds` (equal to the limit), `reason: "limit"`.
  A hang-up at 3 s through `/api/voice/status` writes the exit event with
  `reason: "caller_hung_up"` and `seconds: 3`, and sets outcome `time_wasted`.
  `timeWastedSummary` returns `running: true` before the exit event and
  `formatMmSs(180)` is `"03:00"`. Each event is written exactly once.
  - _Proof: `npx vitest run tests/time-waster.test.ts tests/voice-status.test.ts -t "events"` passes._
  - _MVP, build item 7: Proves entry and exit events are written once._

- [x] **4. Disabled means BLOCK.** With `time_waster_enabled: false` and a HIGH
  transcript: state is `scam_blocked`, outcome `blocked`, the TwiML is the
  exact `blockTwiml()` line "I'm not able to connect this call. Goodbye." plus
  `<Hangup/>`, no `state_change` to `time_wasted`, no grandmother line, and the
  alert hook is still called once.
  - _Proof: `npx vitest run tests/time-waster.test.ts -t "disabled"` passes._
  - _MVP, build item 7: Proves the setting off means a plain block._

- [x] **14. Dashboard duration.** Show "Scammer time wasted: mm:ss" on Live
  and Calls using `timeWastedSummary`. Owned by dashboard-and-simulator; listed
  here so the helper's contract is covered.
  - _Proof: `tests/time-waster-lib.test.ts` for the helper; manual: Live page
    counts up during a persona call and freezes after the exit event._
  - _MVP, build item 11: The Live page shows time wasted._

- [~] **16. Live end-to-end check.** On the real number with the setting on and
  `TIME_WASTER_SECONDS=30`: a scripted gift-card call reaches the persona,
  ends with the goodbye, the dashboard shows about 00:30, and the family gets
  one alert.
  - _Proof: manual run recorded in the PR._
  - _MVP, build item 9: Final check on the real number, with alerts._
  - _Re-plan: Needs build items 7 and 8; run it together with alerts-and-report task 17._

- [x] **13. Dev phone.** Stop treating `time_wasted` as terminal in
  `/api/dev/phone/turn` and show the elapsed time, so the loop and the limit
  can be demoed with `TIME_WASTER_SECONDS=20`.
  - _Proof: manual: dev phone with a gift-card script, then keep talking for
    20 s; the grandmother replies, then the goodbye ends the call._
  - _MVP, build item 14: The dev phone must let the persona loop be demoed._

---

## Deferred (post-hackathon)

Reason: Not needed to show the demo (the demo household is seeded with SQL), so these wait until after the hackathon.

- [~] **15. Settings toggle.** Add `updateHousehold()` to `lib/db.ts`, an
  authenticated settings route, and a switch on the Settings page. A call
  already in `time_wasted` is not affected.
  - _Proof: `tests/settings.test.ts`: PATCH with `false` stores false; manual:
    toggle, reload, state persists._
  - _Deferred: Needs the deferred Settings page. For the demo, set households.time_waster_enabled with SQL; promote this if a single passcode-protected toggle route turns out to be cheap._

---

## Requirement checklist (checked against the code)

_A requirement whose tasks are all deferred is deferred with them. Task placement is in the two sections above._

- [~] **R1** Activation. `computeNextState` exists but is not live. Tasks 7, 12.
- [~] **R2** Disabled means BLOCK. Same code path, not live, no outcome set. Tasks 4, 7, 8.
- [~] **R3** Persona. Prompt block exists, `inTimeWaster` never true. Tasks 6, 7.
- [~] **R4** Reply limits. No guard, no persona fallback. Tasks 5, 7.
- [~] **R5** Reveals nothing real. Prompt includes the family name. Task 6.
- [~] **R6** Entry turn. Not implemented. Tasks 1, 7.
- [~] **R7** Time limit. No timer, no env var. Tasks 2, 5, 7, 11.
- [~] **R8** Events. Only `from` and `to`, no exit event. Tasks 3, 8, 9, 10.
- [~] **R9** Dashboard duration. No helper, no page. Tasks 5, 14.
- [~] **R10** Scoring continues. Not live. Task 7.
- [x] **R11** (part) `timeWasteTwiml()` exists in `lib/twiml.ts`, and
  `buildTwiml()` in `app/api/voice/turn/route.ts` returns it for `time_wasted`.
  - _Proof: `tests/voice-turn.test.ts` "time_wasted: keeps gathering with the
    grandmother line" passes (`Gather`, `Say`, `Redirect`)._
- [~] **R11** (part) Goodbye then `<Hangup/>`. No builder. Task 8.
- [x] **R8** (part) The turn route appends a `state_change` event whenever
  `nextState` differs from the stored state.
  - _Proof: `tests/voice-turn.test.ts` "appends a state_change event only when
    the state changes" passes. The payload has no timestamps (task 10)._
- [~] **R12** Household toggle. No page, no `updateHousehold`. Task 15.
- [~] **R13** Configuration. Tasks 7, 11.
- [~] **R14** Verification. Test tasks 1 to 4.
