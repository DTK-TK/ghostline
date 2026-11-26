# Requirements: conversation-and-scoring

## Overview

When an unknown caller is in the screening flow, Ghostline holds a multi-turn
spoken conversation, scores every turn for scam signals, and decides the next
call state. Sources of truth: `scam-rules.md`, `voice-persona.md`,
`privacy.md`, `tech.md`.

Scoring has two layers:

1. A deterministic rules layer (`lib/scoring/rules.ts`), no network.
2. One Gemini call per turn (`gemini-2.5-flash`, JSON output validated with
   zod), reached through `lib/providers` as `tech.md` requires.

`lib/conversation.ts` (`engine()`) orchestrates both layers. The live route
`app/api/voice/turn/route.ts` must call it directly. The stub
`lib/conversation-engine.ts` must not exist.

---

## R1. Opening line

The first time an unknown caller reaches Ghostline, the system speaks exactly:

> "You've reached the {family_name} residence. This call is screened by
> Ghostline. Please say your name and why you're calling."

`greetingTwiml()` speaks it from `/api/voice/incoming`. The engine and the
Gemini prompt must never repeat it on later turns.

---

## R2. Persona constraints on every reply

- At most 2 sentences and fewer than 25 words.
- Patient and warm. Never sarcastic.
- Never accuse the caller. To decline, say "I'm not able to connect this call."
- Never reveal, hint at, or repeat the safe word. Never confirm whether an
  attempt was close.
- Never give out personal information about the household. The prompt gets
  the family name only.
- Prompt instructions are not enough. Code validates each Gemini reply
  against these rules after generation. A reply that fails is replaced with
  the scripted line for the current band.

---

## R3. Rules layer

`scoreRules(callerUtterances: string[])` is pure, synchronous and zero
network. It scores all caller utterances so far, not only the latest one.

| Flag id | Points |
|---|---|
| `payment_method` | 40 |
| `secrecy` | 30 |
| `authority` | 30 |
| `emergency_story` | 25 |
| `urgency` | 20 |
| `remote_access` | 30 |
| `safe_word_fail` | 50 per failed attempt |
| `callback_denied` | 100 (applied in R5) |

- Each text-based flag fires once per call, however often it is repeated.
- Every example signal in `scam-rules.md` must trigger its flag. Whole-word
  "bank" (`authority`) and "install" (`remote_access`) trigger alone. Bare
  "wire" and "courier" do not: they trigger `payment_method` only with money
  context in the same caller turn ("wire" near money, funds, cash, $, transfer
  or send; "courier", including "courier will pick up / collect", within 40 characters of
  cash, money, funds, $, payment or gift card). Reason: false
  positives on real deliveries and banks.
- `safe_word_fail` points are added to the rules score by the engine from
  `safe_word_attempt` events with `matched: false`.
- Ordinary speech from legitimate callers (doctor's office, pharmacy,
  delivery, neighbour) must not reach MEDIUM through accidental keywords.

---

## R4. AI layer

One Gemini call per turn, through `getAI()` in `lib/providers`:

- model `gemini-2.5-flash`, `responseMimeType: "application/json"`;
- 6-second timeout via `AbortSignal.timeout(6000)`;
- the response is validated with zod: `reply`, `risk_score` (int 0 to 100),
  `flags`, `claimed_identity`, `claims_family`, `requested_amount`,
  `payment_method`, `summary`;
- `flags` is restricted to the known flag ids. Unknown ids are dropped
  before scoring or persisting;
- a timeout, network error, bad JSON or zod failure throws
  `AIUnavailableError` (exported as `GeminiUnavailableError`);
- a missing API key also takes the fallback path in R6, not a thrown 500.

---

## R5. Score combination

`combineScores()` implements `scam-rules.md` in this order:

1. `score = max(rulesScore, aiScore)`. The AI may raise a score, never lower it.
2. `callback_denied`: `score += 100`.
3. Correct safe word and not `callback_denied`: `score = max(0, score - 40)`.
4. Monotonic floor: `score = max(score, priorScore)`.
5. Cap at 100.

Bands: LOW 0 to 39, MEDIUM 40 to 69, HIGH 70 and above. A confirmed
`callback_denied` always yields HIGH.

The engine derives `safeWordCorrect` and `callbackDenied` from `call_events`:

- `safeWordCorrect`: a `safe_word_attempt` event with `matched: true`.
- `callbackDenied`: a `callback_result` event with `outcome: "denied"`.

They are never hardcoded.

---

## R6. Fallback when the AI is unavailable

On `AIUnavailableError`, the engine:

1. continues with rules-only scoring (`aiScore = 0`);
2. replies with the scripted line for the band;
3. logs with `console.error` and never logs keys, tokens or full phone numbers;
4. does not rethrow. The call must not drop.

---

## R7. State transitions

Terms: CONNECT = state `verified`. MESSAGE = state `completed` with the
message TwiML. HIGH path = `time_wasted` (time-waster on) or `scam_blocked`
(time-waster off). SAFE_WORD = state `screening` with the safe-word challenge
reply (see design.md). A caller turn is a non-empty caller transcript event.

| Level | Condition | Next state |
|---|---|---|
| HIGH | any turn, time-waster on | `time_wasted` |
| HIGH | any turn, time-waster off | `scam_blocked` |
| any non-HIGH | caller claims family, safe word not yet passed | SAFE_WORD (`screening`) |
| any non-HIGH | caller claims family, safe word passed | CONNECT (`verified`) |
| MEDIUM | no family claim, fewer than 3 caller turns | `screening` |
| MEDIUM | no family claim, 3 or more caller turns | MESSAGE and a MEDIUM alert |
| LOW | no family claim, fewer than 3 caller turns | `screening` |
| LOW | no family claim, 3 or more caller turns | MESSAGE, no alert |

Acceptance criteria:

1. WHEN an unknown caller's first turn is scored, THE Engine SHALL NOT
   move the call to `verified`, whatever the score.
2. WHEN the caller does not claim to be family and fewer than 3 caller
   turns have been received, THE Engine SHALL keep the call in `screening`
   and keep gathering, unless the level is HIGH.
3. WHEN the caller does not claim to be family, the level is LOW and 3
   caller turns have been received, THE Engine SHALL move the call to MESSAGE
   without sending an alert and without connecting.
4. WHEN the caller does not claim to be family, the level is MEDIUM and 3
   caller turns have been received, THE Engine SHALL move the call to MESSAGE
   and send one MEDIUM alert.
5. WHEN the level is HIGH on any turn, THE Engine SHALL move the call to the
   HIGH path immediately.
6. WHEN the caller claims to be family (`claims_family = true`) and no
   `safe_word_attempt` event has `matched: true`, THE Engine SHALL keep the call
   in `screening` with the safe-word challenge reply and SHALL NOT move to
   CONNECT.
7. WHEN the caller claims to be family and a `safe_word_attempt` event has
   `matched: true`, THE Engine SHALL move the call to CONNECT, except when a
   `callback_result` event has `outcome: "denied"`.
8. WHERE the callback check runs, THE Engine SHALL move the call to the HIGH
   path on `denied`, and SHALL keep the safe-word decision on `confirmed` or
   `no_answer`.
9. WHILE the callback check and the safe-word challenge are not yet
   implemented, THE Engine SHALL move a family claim to SAFE_WORD, keep
   gathering, and SHALL NOT move it to CONNECT.
10. WHEN a caller turn is received, THE Engine SHALL re-evaluate the score
    from the whole transcript so far (all stored caller turns plus the
    current one), and the next state SHALL follow from that score.
11. THE safe-word challenge reply SHALL follow R2 (at most 2 sentences, under
    25 words, no hint of the safe word).

Terminal states (`scam_blocked`, `completed`, `verified`, `transferring`)
never transition. The MEDIUM and LOW screening length (3 caller turns)
replaces the earlier open decision; see design.md.

---

## R8. Event persistence

- One `red_flag` event per newly detected flag, never duplicated for a call.
- After each turn, `calls.risk_score`, `risk_level`, `claimed_identity` and
  `summary` are updated.
- Ghostline's reply is stored as a `transcript` event with `speaker: "system"`,
  so later turns see both sides of the conversation.

---

## R9. State lives in the database

All history comes from `call_events` keyed by CallSid. No module-level state.
The latest caller utterance is not passed twice (once from the stored event
and once as `latestSpeech`).

---

## R10. 10-second budget

Gemini is capped at 6 s. The whole engine call finishes within about 7 s so
the webhook answers Twilio inside 10 s. Prompts stay short.

---

## R11. Test and verification requirements

- All tests run without API keys or network access (Gemini mocked).
- 30 fixture transcripts (15 scams, 15 legitimate), each with an expected level.
- Property-based tests (fast-check) cover: monotonic rules score, payment
  plus urgency is at least MEDIUM, `callback_denied` is always HIGH, the AI
  can only raise the score.
- The turn route tests mock `lib/conversation.ts`.
