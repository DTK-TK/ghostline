# Design: conversation-and-scoring

## Re-plan decisions (hackathon MVP, due Dec 4, 2026)

- **Silence.** One empty caller turn gets a reply and the call keeps gathering. The call hangs up after two consecutive empty turns, counted from `call_events`.
- **MEDIUM alerts.** The MEDIUM alert is sent when a message is taken or when the call ends, never twice (see alerts-and-report). The open decision on MEDIUM stays at its default: screen for up to 3 caller turns, then take a message.
- **Shared path.** `engine()` is called from one place, `processTurn()`, used by the voice route, the dev phone and the simulator (dashboard-and-simulator task 3).
- **Scoring inputs.** `safeWordCorrect` and `callbackDenied` come from stored events (task 2). `callbackConfirmed` comes with safe-word-and-callback task 5.
- **State machine bug fix (task 1b).** `computeNextState` moved a LOW,
  no-claim caller to `verified` on the first turn, so scam calls never got to
  HIGH. New rules (requirements R7): never connect on the first turn; a family
  claim connects only after a matched safe word; no claim means screen for up
  to 3 caller turns, then MESSAGE; HIGH at any turn goes to the HIGH path.
  State mapping: CONNECT = `verified`; MESSAGE = `completed` with the
  existing message TwiML (task 15); HIGH path = `time_wasted` or
  `scam_blocked`; SAFE_WORD = stay in `screening` and reply with the
  challenge ("What's the family word?"). No new DB state: `CallStateSchema`
  has 8 values and `calls.state` is plain `text` with no CHECK constraint
  (migration 0001), so a new value would work, but is not needed. The
  challenge phase is read from the last system transcript, as in
  safe-word-and-callback task 7. The 3-turn limit is also the MEDIUM default,
  so the earlier open decision on MEDIUM is settled at 3.
- **Deferred:** latest-utterance de-duplication (task 7) and widening the rules (task 13). Rule gaps are recorded as `knownGap` in the fixtures.

## Module layout (target)

```
lib/
  conversation.ts        engine(): the only entry point used by the route
  scoring/
    rules.ts             scoreRules(): deterministic, no I/O
    ai.ts                callGemini(): adapter over getAI()
    combine.ts           combineScores(), scoreToLevel()
    reply-guard.ts       validateReply(): persona checks (new)
  providers/
    ai.ts                GeminiAI, OllamaAI, MockAI; zod schema; 6 s timeout
    index.ts             getAI() singleton, AI_PROVIDER switch
```

`lib/conversation-engine.ts` (the `runTurn()` stub) is deleted. The route
imports `engine` from `@/lib/conversation`. Per `structure.md`, the route
holds no business logic.

## Data flow per turn

```
POST /api/voice/turn
  validateTwilioRequest -> getCallBySid, getHousehold
  appendEvent(transcript, caller)
  silence check (DB-backed count)
  engine({ callSid, speechResult, currentState, currentRiskScore })
    getCallEvents(call.id)
    callerUtterances = caller transcripts, latest speech once
    rules  = scoreRules(callerUtterances)
    failed = count(safe_word_attempt where matched=false)
    rulesScore = rules.score + 50 * failed
    ai     = callGemini(...)           6 s, zod, on failure aiScore = 0
    flags  = rules.flags + known AI flags
    safeWordCorrect = any safe_word_attempt matched=true
    callbackDenied  = any callback_result outcome="denied"
    combined = combineScores({ rulesScore, aiScore, allFlags, safeWordCorrect,
                               callbackDenied, priorScore })
    reply = validateReply(ai.reply) ?? scripted line for combined.level
    appendEvent(red_flag) for new flags only
    appendEvent(transcript, system) for the reply
    updateCall(risk_score, risk_level, claimed_identity, summary)
    nextState = computeNextState(...)
  appendEvent(state_change) if changed; updateCall(state, risk)
  buildTwiml(nextState, reply)
```

## Scoring

- Rules layer: regex table in `rules.ts`, one hit fires a flag once. Raw sum
  can exceed 100 (max 175). `combineScores` caps it.
- AI layer: `GeminiAI.generateTurn` in `lib/providers/ai.ts`. Temperature 0.2,
  512 output tokens, `AbortSignal.timeout(6000)`, zod
  `AITurnResponseSchema`. All failures become `AIUnavailableError`.
  `lib/scoring/ai.ts` is a thin adapter that keeps the `callGemini` name.
- Combine: order given in requirements R5. `callback_denied` adds 100 before
  the safe-word step, so the step is skipped for it. Result is at least 100
  after the cap, therefore HIGH.
- `safe_word_fail` (50 each) is added to the rules score in the engine, so
  `combineScores` keeps its current signature.

## Reply guard

`validateReply(text)` returns the text or `null`. It rejects replies with more
than 2 sentences, 25 or more words, or accusatory words ("scam", "scammer",
"fraud", "fraudster", "criminal"). The engine never holds the safe word (only
a bcrypt hash exists), so the prompt cannot leak it. The guard also rejects
any reply that repeats the opening line. Null means: use the scripted line.

## Fallback

```
LOW:    "Thank you. Could you tell me more about why you're calling?"
MEDIUM: "I need a moment. Could you tell me your name and reason for calling?"
HIGH:   "I'm not able to connect this call. Goodbye."
```

Applies when the AI is unavailable (timeout, bad JSON, missing key) or the
reply guard rejects the AI reply. The time-waster persona fallback belongs to
the time-waster spec. `engine()` currently never passes `inTimeWaster = true`,
so that persona is unreachable until that spec lands.

## State machine

Decision order in `computeNextState` (terminal states never move):

```
1. HIGH, any turn            -> time_wasted (time-waster on) | scam_blocked
2. claims_family             -> matched safe word (and no denied callback)
                                  ? verified            (CONNECT)
                                  : screening + challenge reply (SAFE_WORD)
3. no claim, caller turns < 3 -> screening
4. no claim, caller turns >= 3 -> completed + message TwiML (MESSAGE)
                                  MEDIUM: one MEDIUM alert; LOW: no alert
```

`verified` is reachable only through step 2 with a matched safe word, so it
can never happen on the first turn. A denied callback reaches HIGH through
the score (R5), so step 1 handles it. `confirmed` and `no_answer` change
nothing: the safe-word decision stands.

Mapping: CONNECT = `verified`, MESSAGE = `completed` plus message TwiML,
HIGH path = `time_wasted` or `scam_blocked`, SAFE_WORD = `screening` with
the challenge reply. The challenge is detected from the last system
transcript (safe-word-and-callback task 7). Until that task lands, a family
claim keeps the call in `screening` and the engine replies with the
challenge line "What's the family word?" (9 words, one sentence, R2 compliant
and added to the scripted fallbacks). The family claim itself comes from
the AI's `claims_family`, with the deterministic pattern fallback in
safe-word-and-callback task 9 when the AI is down.

Because the score is recomputed every turn from all stored caller turns plus
the current one, a scam that only shows its signals on turn 2 or 3 reaches
HIGH while the call is still in `screening`.

Open decision: none on state values. If SAFE_WORD turns out to need its own
state (for example if the last-system-transcript check proves too fragile),
adding `safe_word` to `CallStateSchema` is the unavoidable alternative. No
migration would be needed, as `calls.state` has no CHECK constraint.

## Known defects in the current code (all verified by reading the files)

1. `app/api/voice/turn/route.ts` imports the stub `runTurn`, which always
   replies with a canned line and score 0. The real `engine()` runs only from
   `/api/dev/phone/turn`.
2. `engine()` hardcodes `safeWordCorrect: false` and `callbackDenied: false`.
3. The route's `computeSilenceCount` returns the limit for any empty speech
   in `screening`, so one silent turn ends the call.
4. The route stores the caller turn before calling the engine. The engine
   then appends `speechResult` again, and `formatHistoryForPrompt` appends
   `latestSpeech` again, so the latest utterance appears twice in the prompt.
5. Ghostline's own replies are never stored as transcript events, so Gemini
   never sees its earlier lines.
6. The Gemini prompt tells the model to speak the opening line on its first
   turn, but the greeting is already spoken by TwiML.
7. `GeminiAI`'s constructor throws a plain `Error` on a missing
   `GEMINI_API_KEY`. The engine only catches `GeminiUnavailableError`, so
   it rethrows and the route returns the generic error TwiML.
8. AI `flags` are `z.array(z.string())` and are persisted as `red_flag`
   events without checking against the known ids.
9. Rules signals (updated in task 17, see R3): authority and remote access
   now match whole-word "bank" and "install". Bare "wire" and "courier" match
   `payment_method` only with money context (cash, money, funds, $, payment,
   gift card, within 40 characters) in the same caller turn. "Courier will
   pick up / collect" has no unconditional pattern of its own (false
   positives on real deliveries and banks). Broad matches
   (`emergency`, `hospital`, `in trouble`) risk false positives: a doctor's
   office saying "hospital" plus "right now" scores 45 (MEDIUM).
10. No reply guard exists, so the 25-word and no-accusation rules are
    prompt-only.
11. `safe_word_fail` (50 per failure) has no implementation.
12. MEDIUM never takes a message. It stays in `screening` forever.
13. `getAI()` caches the provider in a module singleton. Tests that change
    `AI_PROVIDER` must call `vi.resetModules()`.

## Testing strategy

| File | Covers |
|---|---|
| `tests/helpers/gemini.ts` | Shared `GoogleGenAI` mock (success, bad JSON, throw, slow) |
| `tests/scoring-rules.test.ts` | Flag table, once-per-call, bare-signal triggers |
| `tests/scoring-combine.test.ts` | Every R5 branch, boundaries 39/40/69/70, cap |
| `tests/scoring-properties.test.ts` | fast-check properties (see tasks) |
| `tests/scoring-ai.test.ts` | Gemini config, timeout, zod failure, unknown flags dropped |
| `tests/reply-guard.test.ts` | Word, sentence and accusation checks |
| `tests/conversation.test.ts` | `engine()` turns with `lib/db` mocked |
| `tests/fixtures/scams.json`, `legitimate.json` | 30 labelled transcripts |
| `tests/fixtures.test.ts` | Runs every fixture through rules and combine |
| `tests/voice-turn.test.ts` | Route test, mocks `@/lib/conversation` |

Fixture entry shape:
`{ id, category, caller: string[], safeWordCorrect?: boolean, expectedLevel }`.
Names are fake. No real phone numbers. Fixtures state the intended level. If
the rules misjudge one, either fix the rules or mark the entry
`knownGap: true` with a reason, and run it with `it.fails` so the suite stays
green and flips when fixed. Never edit `expectedLevel` to match the output.
