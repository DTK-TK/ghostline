# Design: safe-word-and-callback

## Re-plan decisions (hackathon MVP, due Dec 4, 2026)

- The safe word is seeded with SQL (pgcrypto hash) for the demo. The Settings page and `hashSafeWord` for Settings (task 14) are deferred.
- In scope: safe word challenge and check, callback start, `/api/voice/callback`, `/api/voice/hold-check`, `/api/voice/callback-result`, scoring with both results, alert on denial, dev phone buttons (1 = denied, 2 = confirmed).
- A denied callback enters HIGH through `enterHighRisk()` (time-waster task 12), so it ends as `time_wasted` or `scam_blocked` like any other HIGH call.
- The alert on denial follows the shared rule: sent immediately, never twice.
- Phone numbers are masked in every log.

## Module layout (target)

```
lib/
  safe-word.ts            normalise(), stripLeadIn(), checkSafeWord()      (new)
  callback.ts             startCallback(), recordCallbackResult(),
                          holdDecision(), maskPhone()                      (new)
  conversation.ts         engine(): challenge, attempt handling, callback start
  scoring/combine.ts      adds callbackConfirmed, credits after the floor
  providers/telephony.ts  startCallbackCall() (exists), URLs aligned below
app/api/voice/
  callback/route.ts           answer webhook for the family member's phone (new)
  callback-result/route.ts    digit and call-status webhook (new)
  hold-check/route.ts         caller-side hold loop (new)
```

Routes only validate the signature, parse params and call `lib/`.

## Safe-word flow

Challenge phase is derived from `call_events`, not from `calls.state`.
`CallStateSchema` has no `safe_word` state and none is added.

```
turn N: AI says claims_family -> reply = "What's the family word?"
        (stored as a system transcript; this is the phase marker)
turn N+1: last system transcript is the challenge AND no matched attempt
          AND fewer than 2 attempts
   -> do NOT store the speech as a transcript; store "[safe word attempt]"
   -> do NOT call Gemini or the rules layer on it
   -> candidates = [normalise(text), normalise(stripLeadIn(text))] (max 2)
   -> bcryptjs.compare each against households.safe_word_hash
   match:  safe_word_attempt {matched:true, attempt:"[redacted]"}
           score credit -40; verified unless final level is HIGH
   miss:   safe_word_attempt {matched:false, attempt:"[redacted]"}
           +50; first miss: reply "Sorry, I didn't catch that. What's the family word?"
           second miss: score >= 100 -> HIGH flow
```

The route must run this check before it appends the transcript event. Today
`app/api/voice/turn/route.ts` appends `SpeechResult` first, and `engine()`
builds the Gemini history from those events, so the spoken word would be
written to the database and sent to Google. The challenge check therefore
moves into the engine's entry (or a helper it calls) and the route skips the
plain transcript write for that turn.

Normalisation and compare cost: bcryptjs at cost 12 takes about 340 ms per
compare on this machine (measured). Two compares fit the 10 s budget. Tests
use cost 4.

`normalise` is the single function used by the Settings page when it saves a
new word (hash the normalised word) and by the check. Singularise rule: for
each word longer than 3 letters, "ies" becomes "y", a trailing "s" is
dropped unless it ends in "ss" or "us".

### Hash compatibility: bcryptjs and pgcrypto

The seed (`supabase/seeds/demo.sql`) hashes with
`crypt('pumpkin', gen_salt('bf', 12))`. The app verifies with `bcryptjs`.

- pgcrypto's `gen_salt('bf')` writes the `$2a$` prefix. `bcryptjs` produces
  `$2b$`. The prefixes differ only for passwords longer than 255 bytes, which
  safe words never are.
- Checked by running bcryptjs here: `compareSync` accepts `$2b$`, `$2a$` and
  `$2y$` forms of the same hash. A `$2b$` prefix is therefore not required.
  The seed only has to produce a standard bcrypt hash, and cost 12 is fine.
- The seeded word must already be in normalised form (`pumpkin` is).
  A seed that changes the word must hash the normalised word.
- `tests/helpers/voice.ts` has a placeholder hash that never matches (bcryptjs
  returns `false`, it does not throw). Tests that need a match must create a
  hash with `bcrypt.hashSync(word, 4)`.
- To verify after seeding: `select left(safe_word_hash, 4) from households;`
  should return `$2a$`, and the dev phone should accept "pumpkin".

## Callback flow

```
claims named family member, target exists, no callback_started yet
  appendEvent(callback_started {target_phone})
  telephony.startCallbackCall(target.phone, callSid, safeName)   (try/catch)
  reply to caller: "Please hold one moment." + Pause 10 + Redirect hold-check?n=1
```

Family member's phone (Twilio calls `url` when answered):

```
POST /api/voice/callback?originalCallSid=..&claimedName=..
  <Gather numDigits=1 timeout=10 action=/api/voice/callback-result?originalCallSid=..>
    <Say>This is Ghostline. Someone saying they are NAME is calling FAMILY
         right now. Press 1 if you are safe and NOT calling. Press 2 if it
         really is you.</Say>
  </Gather>
  <Say>We did not get a response. Goodbye.</Say><Hangup/>
```

`POST /api/voice/callback-result` handles both the Gather digit and the
`statusCallback`:

| Request | Result |
|---|---|
| `Digits=1` | `denied`: +100, HIGH flow |
| `Digits=2` | `confirmed`: -40 |
| other digit | repeat prompt once, then `no_answer` |
| no `Digits`, `CallStatus` in no-answer, busy, failed, canceled, completed | `no_answer` (only if no result exists) |

`recordCallbackResult(callSid, outcome)`:
1. finds the original call; ignores a result if one already follows the
   latest `callback_started` (first result wins, so Twilio retries are safe);
2. appends `callback_result`;
3. recomputes the score with `combineScores` from all events and writes
   `risk_score`, `risk_level`, and on HIGH the state (`time_wasted` or
   `scam_blocked`) plus a `state_change` event;
4. alert and report generation come from the alerts-and-report spec (a HIGH
   result triggers them there).

Telephony URL alignment: `TwilioTelephony.startCallbackCall` currently
points `url` at `/api/voice/callback` (planned) and `statusCallback` at
`/api/voice/callback/status` (no such route). The status callback is
repointed to `/api/voice/callback-result?originalCallSid=..`.

The provider returns `void`, so the callback leg's own SID is unknown and the
ringing call cannot be cancelled when the hold loop gives up. A late press
after `no_answer` is ignored because the first result wins.

## Hold loop

```
turn (starts callback): Say "Please hold one moment." / Pause 10 / Redirect hold-check?n=1
hold-check?n=k:
  result denied     -> HIGH TwiML (time-waster or block)
  result confirmed  -> re-score, then connect if LOW, otherwise per band
  pending, k < 4    -> Pause 10 / Redirect hold-check?n=k+1
  pending, k = 4    -> record no_answer, Say "Thank you for waiting.", Gather (normal screening)
  call already ended -> Hangup
```

Four 10-second pauses plus the spoken lines are about 45 seconds. `n` is
validated with zod (1 to 4); anything else is treated as 4.

## Scoring changes (combine.ts)

Current code (read from `lib/scoring/combine.ts`):

```
score = max(rules, ai)
if denied: score += 100
if safeWordCorrect && !denied: score = max(0, score - 40)
score = max(score, priorScore)      // floor
score = min(100, score)
```

Two problems:

1. There is no input for a confirmed callback. Add `callbackConfirmed`
   (-40, floor 0, ignored when denied).
2. The floor runs after the credit, and `priorScore` is the stored net score.
   Example: the transcript scores 45, the stored score is 45, the caller
   gives the right word. Credit gives 5, the floor lifts it back to 45. The
   credit never takes effect on any later turn.

Chosen fix (to be confirmed with the conversation-and-scoring spec, which
owns this file): apply the floor to the gross score and the credits after it.

```
gross = max(max(rules, ai) + (denied ? 100 : 0), priorScore + priorCredits)
net   = denied ? gross : max(0, gross - credits)
score = min(100, net)
```

`credits` is 40 per credit in effect now. `priorCredits` is the credit that
was already reflected in the stored `risk_score`. Every code path that writes
a credit event also rescores immediately, so at the next turn `priorCredits`
equals the credit derived from all events written before this invocation.
`lib/scoring` gets one helper, `creditsFromEvents(events)`, used by the
engine, `recordCallbackResult` and `hold-check`.

`safe_word_fail` points (50 each) are added to `rulesScore` by the engine
(conversation-and-scoring task 14), so `combineScores` needs no new input
for them.

## Open decisions

1. Order of safe word and callback. Default: place the callback on the claim
   turn and ask for the family word in the same reply, so the family member's
   phone rings while the caller answers. The hold loop starts only if the
   challenge has ended with no callback result yet. Alternative: callback
   only after a failed word, which spares the family unneeded calls.
2. Which target is called when several have `is_callback_target`. Default:
   the first returned by `getCallbackTargets`.
3. After `confirmed` with a final score still at 40 to 69, the call follows
   the MEDIUM flow from the conversation-and-scoring spec.

## Known defects in the current code (verified by reading the files)

1. `lib/safe-word.ts` does not exist. No file imports `bcryptjs`, although it
   is in `package.json`.
2. `engine()` passes `safeWordCorrect: false` and `callbackDenied: false`.
3. The routes `/api/voice/callback`, `/api/voice/callback-result` and
   `/api/voice/hold-check` do not exist. `startCallbackCall` is defined
   (Twilio and Mock) but nothing calls it. The Twilio implementation targets
   `/api/voice/callback` and `/api/voice/callback/status`.
4. `app/api/dev/phone/callback-answer/route.ts` is dev-only and differs from
   this spec: 1 = confirmed and 2 = denied (reversed), confirmed changes no
   score, denial always sets `scam_blocked` (ignores the time-waster), and its
   header comment says the body field is `callId` while the code reads
   `callSid`. `phone-client.tsx` has matching buttons.
5. `combineScores` has no `callbackConfirmed`, and the floor cancels credits.
6. The turn route writes the raw `SpeechResult` as a transcript event before
   the engine runs, so a spoken safe word would be stored in plaintext and
   sent to Gemini. The `safe_word_attempt` schema also stores `attempt:
   string`.
7. `MockTelephony` logs full phone numbers with `console.log`.
8. `CallStateSchema` has no `safe_word` state, although the turn route's
   comments mention one. This design does not need one.
9. The test helper hash in `tests/helpers/voice.ts` is a placeholder.

## Testing strategy

| File | Covers |
|---|---|
| `tests/safe-word.test.ts` | normalise, lead-in strip, real bcryptjs hash (cost 4), `$2a$`/`$2y$` acceptance, redaction, two-failure HIGH, -40 |
| `tests/callback.test.ts` | start once only, prompt text, digit mapping, first result wins, no_answer no change |
| `tests/voice-callback-result.test.ts` | signature 403, digit 1/2, status no-answer, idempotence |
| `tests/voice-hold-check.test.ts` | signature 403, pending loop, n=4 gives no_answer, denied gives HIGH TwiML |
| `tests/scoring-combine.test.ts` | confirmed credit, floor-after-credit, denied always HIGH |

Route tests reuse `twilioRequest`, `parseTwiml`, `householdFixture` and
`callFixture` from `tests/helpers/voice.ts` and the existing mocking style
(`vi.hoisted` mocks of `@/lib/db`, `MOCK_TELEPHONY=true`).
