# Design — conversation-and-scoring

## Overview

The conversation engine is the heart of Ghostline. It sits between the Twilio
turn webhook and the TwiML builders, loading history from the DB, running two
scoring layers in parallel, persisting new evidence, and returning the next
persona reply and state.

---

## Module layout

```
lib/
  conversation.ts         engine() — main entry point (replaces the stub)
  conversation-engine.ts  runTurn() stub — route.ts imports this; wire to engine()
  scoring/
    rules.ts              scoreRules() — deterministic keyword scorer
    ai.ts                 callGemini() — Gemini 2.5 Flash, JSON mode
    combine.ts            combineScores() — merges both layers, applies adjustments
```

---

## Data flow per turn

```
POST /api/voice/turn
        │
        ▼
validateTwilioRequest()   ← throws 403 on bad sig
        │
        ▼
getCallBySid() + getHousehold()
        │
        ▼
appendEvent(transcript)   ← always, including silent turns
        │
        ▼
        ├─ silence ×2 → silenceGoodbyeTwiml()
        │
        ▼
engine(input)
   ├─ getCallEvents()          load full history from DB
   ├─ scoreRules(transcripts)  synchronous, no network
   ├─ callGemini(...)          6 s timeout
   │      └─ GeminiUnavailableError → scripted fallback
   ├─ combineScores(...)        deterministic merge
   ├─ appendEvent(red_flag)×N  one per new flag only
   ├─ updateCall(...)           risk_score, risk_level, claimed_identity, summary
   └─ computeNextState(...)     level + claims_family + time_waster_enabled
        │
        ▼
appendEvent(state_change)   if state changed
updateCall(state, risk_*)
        │
        ▼
buildTwiml(nextState, reply, ...)
        │
        ▼
twimlResponse(xml)
```

---

## Scoring layers

### Rules layer (`lib/scoring/rules.ts`)

Pure function. Takes the full array of caller utterances collected so far
(not just the latest turn) and returns `{ score, flags }`.

Each flag fires at most once per call. The score is the sum of unique
triggered flag weights. Runs synchronously with no I/O so it adds ~0 ms to
the response time.

```typescript
export function scoreRules(transcript: string[]): RulesResult
```

### AI layer (`lib/scoring/ai.ts`)

Calls `gemini-2.5-flash` in JSON mode. The system prompt embeds:
- Family name (for the opening line).
- Persona rules (tone, sentence limits, forbidden actions).
- Flag IDs the model must use (`payment_method`, `secrecy`, …).
- State-guidance hints keyed to risk bands.

Returns a Zod-validated `GeminiResponse`. On any failure throws
`GeminiUnavailableError`.

```typescript
export async function callGemini(
  familyName: string,
  history: ConversationTurn[],
  latestSpeech: string,
): Promise<GeminiResponse>
```

### Combine layer (`lib/scoring/combine.ts`)

```typescript
export function combineScores(input: CombineInput): CombineResult
```

Order of operations (must match scam-rules.md exactly):
1. `score = max(rulesScore, aiScore)`
2. if `callbackDenied`: `score += 100`
3. if `safeWordCorrect && !callbackDenied`: `score = max(0, score − 40)`
4. `score = max(score, priorScore)` — monotonic floor
5. `score = min(100, score)` — DB cap

---

## State machine (engine's view)

```
screening ──low, no family claim──► verified
screening ──low, claims family   ──► screening (safe-word phase)
screening ──medium               ──► screening (keep asking)
screening ──high, TWE on         ──► time_wasted
screening ──high, TWE off        ──► scam_blocked

time_wasted ──3 min elapsed      ──► scam_blocked (or completed)

verified    ──(terminal)
scam_blocked──(terminal)
completed   ──(terminal)
transferring──(terminal)
```

TWE = `households.time_waster_enabled`

Terminal states never transition. The engine checks this before computing
the new state.

---

## Gemini system prompt structure

```
You are Ghostline … for the {familyName} family.

PERSONA RULES: (opening line, sentence limits, forbidden actions)

SCAM FLAG IDs: payment_method | secrecy | authority | emergency_story |
               urgency | remote_access

NEXT-STATE GUIDANCE: (per risk band)

Respond ONLY with valid JSON:
{ reply, risk_score, flags, claimed_identity, claims_family,
  requested_amount, payment_method, summary }
```

The prompt is built in `buildSystemPrompt(familyName)` in `lib/scoring/ai.ts`.
No family member names, phone numbers, or the safe word are included.

---

## Fallback strategy

```
callGemini()
  throws GeminiUnavailableError
        │
        ▼
usedFallback = true
console.error("[conversation] Gemini unavailable …")
        │
        ▼
aiScore = 0, aiFlagsIds = []
        │
        ▼
combineScores({ rulesScore, aiScore: 0, … })
        │
        ▼
reply = FALLBACK_REPLIES[level]
  low:    "Thank you. Could you tell me more about why you're calling?"
  medium: "I need a moment. Could you tell me your name and reason for calling?"
  high:   "I'm not able to connect this call. Goodbye."
```

The call is never dropped. The rules layer keeps scoring even when Gemini
is down.

---

## `runTurn()` wiring

`lib/conversation-engine.ts` currently exports a stub. The turn route imports
`runTurn` from that file. Once the real engine is complete, `runTurn` must be
re-exported from `lib/conversation-engine.ts` by delegating to `engine()` from
`lib/conversation.ts`, preserving the existing import path in the route.

```typescript
// lib/conversation-engine.ts (after wiring)
export { engine as runTurn } from "@/lib/conversation";
export type { EngineInput as TurnInput, EngineOutput as TurnOutput } from "@/lib/conversation";
```

---

## Red-flag deduplication

The engine loads all existing `red_flag` events for the call from
`call_events` and collects their `flag` payloads into `priorFlagIds`. It only
appends new `red_flag` events for flags NOT already in that set. This keeps
the event log clean and avoids double-counting across turns.

---

## Error budget

| Step | Budget |
|---|---|
| `getCallEvents()` | ≤ 150 ms |
| `scoreRules()` | < 1 ms |
| `callGemini()` | ≤ 6 000 ms (AbortSignal.timeout) |
| `appendEvent()` × N flags | ≤ 100 ms each |
| `updateCall()` | ≤ 100 ms |
| **Total engine budget** | **≤ 7 s** |

The turn route's outer 10-second Twilio deadline leaves ~3 s for the
surrounding webhook logic.

---

## Testing strategy

| Test file | What it covers |
|---|---|
| `tests/scoring-rules.test.ts` | Property-based: flag fires iff keyword present; score = sum of unique weights |
| `tests/scoring-combine.test.ts` | All six adjustment branches; monotonic floor; DB cap |
| `tests/scoring-ai.test.ts` | GeminiUnavailableError on timeout / bad JSON; happy-path Zod parse |
| `tests/conversation.test.ts` | Full engine turns: state transitions, fallback path, dedup |
