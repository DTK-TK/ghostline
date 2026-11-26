# Design — safe-word-and-callback

## Overview

The safe-word and callback mechanisms are two independent but cooperating
defences against a caller who falsely claims to be a family member. Both are
triggered by `claims_family = true` from the AI layer and both feed results
back into `combineScores()`.

---

## Module layout

```
lib/
  conversation.ts       engine() — hosts safe-word check and callback dispatch
  scoring/combine.ts    combineScores() — applies safe_word_fail (+50 each),
                          safe_word_correct (−40), callback_denied (+100)
  db.ts                 appendEvent(), getCallbackTargets(), getCallBySid()

app/api/voice/
  turn/route.ts         receives safe-word speech, delegates to engine()
  callback/route.ts     (new) Twilio webhook for the outbound callback leg
```

---

## Safe-word flow

```
engine() receives turn where claims_family = true
        │
        ▼
nextState = "screening"  (safe-word challenge phase)
reply = "Could you give me the family verification word, please?"
        │
        ▼
caller speaks on next turn
        │
        ▼
engine() — safeWordPhase detected from call_events
  normalise(speechResult)  → lowercase + trim
  bcrypt compare: crypt(normalised, safe_word_hash) === safe_word_hash
        │
        ├─ MATCH ──► appendEvent(safe_word_attempt, matched=true)
        │             combineScores({ safeWordCorrect: true })   → −40, floor 0
        │             nextState = "verified"
        │             reply → connectTwiml()
        │
        └─ NO MATCH → appendEvent(safe_word_attempt, matched=false)
                       combineScores({ safe_word_fail flag })    → +50
                       attempt count from call_events
                         ≤ 1 failure: stay "screening", ask again
                         ≥ 2 failures: HIGH risk → time_wasted or scam_blocked
```

### Safe-word phase detection

The engine detects it is in the safe-word phase by counting
`safe_word_attempt` events in `call_events`. If the count is 0 and
`claims_family` is true on this turn, the engine enters the challenge
(prompt for the word). If the count is ≥ 1, the current speech is treated as
an attempt.

The challenge prompt must never include the word itself, synonyms, or any
hint about format or length.

### Bcrypt comparison

```typescript
import bcrypt from "bcryptjs";

function checkSafeWord(attempt: string, hash: string): boolean {
  const normalised = attempt.toLowerCase().trim();
  return bcrypt.compareSync(normalised, hash);
}
```

`bcryptjs` is used server-side only. The hash lives in
`households.safe_word_hash` and must never be sent to the browser.

---

## Callback flow

```
engine() — claims_family = true, callback_targets exist, not yet initiated
        │
        ▼
appendEvent(callback_started, { target_phone })
        │
        ▼
Twilio REST API → calls.create({
  to:   target_phone,
  from: TWILIO_PHONE_NUMBER,
  url:  PUBLIC_BASE_URL + "/api/voice/callback",
  statusCallback: PUBLIC_BASE_URL + "/api/voice/callback/status",
})
        │
        ▼
callback target's phone rings
        │
        ├─ ANSWERED ──► /api/voice/callback TwiML
        │                 <Say> "A caller claims to be you. Press 1 to confirm,
        │                        2 to deny."
        │                 <Gather numDigits="1" action="/api/voice/callback/result">
        │
        └─ NO ANSWER  ──► Twilio fires no-answer status
                           POST /api/voice/callback/status
                           appendEvent(callback_result, { outcome: "no_answer" })
                           no score change
```

### `/api/voice/callback/result` (new route)

Receives the DTMF digit from the family member:

| Digit | Outcome | Action |
|---|---|---|
| `1` | confirmed | `appendEvent(callback_result, { outcome: "confirmed" })` — no score change |
| `2` | denied | `appendEvent(callback_result, { outcome: "denied" })` + `combineScores({ callbackDenied: true })` → +100, transition to `scam_blocked` |
| timeout | no_answer | `appendEvent(callback_result, { outcome: "no_answer" })` |

The score update and state transition are applied by patching the original
call's `calls` row (looked up by the `CallSid` stored when the callback was
initiated). The original screening call continues in parallel; the next turn
from the caller picks up the updated score.

### Callback initiation guard

A callback is initiated at most once per call. The engine checks for an
existing `callback_started` event before dialling. If one exists, the
callback is not re-initiated.

---

## Score interaction summary

| Event | combineScores input | Score effect |
|---|---|---|
| Correct safe word | `safeWordCorrect: true` | −40 (floor 0), never cancels callback_denied |
| Each wrong safe word | `safe_word_fail` flag | +50 per failure |
| Callback denied | `callbackDenied: true` | +100 (applied before safe-word credit) |
| Callback confirmed | (no change) | 0 |
| Callback no answer | (no change) | 0 |

The `callback_denied` escalation is permanent. Even if the caller then gives
the correct safe word, `combineScores` applies the +100 first, so the −40
credit cannot bring the score below 60 (100 − 40 = 60, still MEDIUM; more
likely scores will be capped at 100).

---

## Privacy constraints

- `safe_word_attempt` event payload stores `matched: boolean` and
  `attempt: string`. The attempt field holds the normalised caller speech. It
  must never be echoed back to the caller in a voice response.
- Phone numbers in `callback_started.target_phone` must not appear in any
  `console.log` output.
- The safe word hash must never appear in logs, API responses, or client-side
  code.

---

## Testing strategy

| Test file | What it covers |
|---|---|
| `tests/safe-word.test.ts` | Correct word → verified; wrong word ×2 → HIGH; score arithmetic; never reveals word in reply |
| `tests/callback.test.ts` | Digit 1 → confirmed; digit 2 → denied + +100; no-answer → no change; guard against double-initiation |
| `tests/scoring-combine.test.ts` | callback_denied overrides safe_word_correct; monotonic floor |
