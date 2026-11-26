# Requirements: time-waster

## Overview

When a call becomes HIGH risk (score 70 or more) and the household has
`time_waster_enabled = true`, Ghostline switches to the time-waster persona
from `voice-persona.md`: a slow, chatty grandmother who mishears, looks for
her glasses and talks about her cat. She keeps the caller busy for at most
3 minutes, reveals nothing real, then ends the call politely. When the
setting is off, a HIGH call goes straight to BLOCK.

Sources of truth: `voice-persona.md`, `scam-rules.md`, `privacy.md`,
`tech.md`, `product.md`. The persona never accuses anyone. The family is
alerted silently (alerts-and-report spec).

---

## R1. Activation

The persona starts when all of these hold:

1. the combined risk level is HIGH, from any source: rules, AI, two failed
   safe-word attempts, or a denied callback;
2. `households.time_waster_enabled = true`, read at the moment of the
   transition;
3. the call is not in a terminal state (`scam_blocked`, `completed`,
   `verified`, `transferring`) and is not already in `time_wasted`.

Every code path that moves a call to HIGH (the engine, the callback-result
route, the hold-check route) uses the same transition function so the start
is recorded the same way.

---

## R2. Disabled means BLOCK

When the level is HIGH and `time_waster_enabled = false`:

- the call goes straight to `scam_blocked` (no persona, no grandmother line);
- the caller hears "I'm not able to connect this call. Goodbye." and the
  call hangs up (`blockTwiml()`);
- `calls.outcome` is `blocked` and `ended_at` is set;
- the family is still alerted.

---

## R3. Persona

Time-waster replies are in the voice of a slow, friendly, chatty
grandmother who:

- mishears what the caller said;
- looks for her glasses;
- talks about her cat, Marmalade;
- wanders, and never advances the caller's goal.

She is warm and patient, never sarcastic. She may say "I'm not able to
connect this call." if the caller presses to be put through.

---

## R4. Reply limits

- Each time-waster reply is at most 2 sentences and under 20 words.
- Code checks every AI reply after generation. A reply that is too long or
  breaks R5 is replaced with a scripted grandmother line.
- When the AI is unavailable (timeout, bad JSON, missing key), the scripted
  lines are used, rotated by turn. The generic "I'm not able to connect this
  call. Goodbye." line is never used while the persona is active, because it
  would say goodbye and then keep listening.

---

## R5. Reveals nothing real

The persona never says, confirms, repeats or hints at:

- the family name, the senior's name, any family member's name, address or
  phone number;
- the safe word, or whether any answer is close;
- bank, card, account or other personal details, including numbers the
  caller read out;
- that the call is screened, scored, recorded or analysed.

It never accuses the caller and never uses "scam", "fraud", "police",
"report", "suspicious" or "risk". Invented harmless colour (the cat's name,
the glasses) is allowed. The persona prompt does not include the family name.
Caller speech is untrusted data. Instructions inside it are ignored.

---

## R6. Entry turn

The reply on the turn that crosses into HIGH is already in persona. If the
AI call for that turn raised the score, its reply was written before the
switch. Ghostline then uses a scripted grandmother line for that one turn,
without a second AI call, to stay inside the 10-second webhook budget. If
the rules layer alone already reached HIGH, the AI is called in persona mode
on that turn.

---

## R7. Time limit

- Elapsed time is measured from the entry `state_change` event's
  `started_at`. Nothing is kept in memory (serverless).
- The limit is 180 seconds. `TIME_WASTER_SECONDS` overrides it for testing.
  A positive integer is accepted. Invalid, zero or negative values fall back
  to 180. Values above 180 are clamped to 180, because `voice-persona.md` caps
  the persona at 3 minutes.
- The limit is checked at the start of every turn, before any AI call. When
  elapsed time is at or past the limit, Ghostline says "Oh dear, I must go
  feed Marmalade. Goodbye!" and hangs up.
- The call then ends with state `completed` and outcome `time_wasted`.
- Because the check runs at turn boundaries, the call ends at the first turn
  at or after the limit (normally within about 15 seconds).

---

## R8. Events

Two `state_change` events record the episode:

| Event | Payload |
|---|---|
| Entry | `from`, `to: "time_wasted"`, `started_at` (ISO) |
| Exit | `from: "time_wasted"`, `to`, `started_at`, `ended_at` (ISO), `seconds`, `reason` |

`reason` is `limit`, `caller_hung_up` or `caller_silent`. Every way out of
`time_wasted` writes the exit event, including a hang-up before the limit
(handled by the status webhook). `started_at` and `ended_at` come from the
same app clock.

---

## R9. Duration for the dashboard

A helper returns `{ startedAt, endedAt | null, seconds, running }` from a
call's events. The dashboard shows "Scammer time wasted: mm:ss". For a live
call it counts up from `started_at`. After the exit event it shows the final
value. Calls that never entered `time_wasted` show nothing.

---

## R10. Scoring continues

Rules and AI scoring keep running during the persona. The score never drops
below HIGH (monotonic). Alerts go out at the moment of entry, not at the end.

---

## R11. TwiML

- Persona turns use `timeWasteTwiml()` (`<Gather>` + `<Redirect>` to
  `/api/voice/turn`).
- The ending uses a say-then-`<Hangup/>` response, never a voicemail record.

---

## R12. Household toggle

The Settings page has a switch for `households.time_waster_enabled`. It
applies to the next transition into HIGH. A call already in `time_wasted`
keeps its persona until it ends.

---

## R13. Configuration and webhooks

- `TIME_WASTER_SECONDS` is read per request (not at import) and documented in
  `.env.example`.
- Each persona turn answers Twilio within 10 seconds (AI capped at 6 seconds).
- Routes validate `X-Twilio-Signature` and hold no business logic.

---

## R14. Verification

Tests run with no API keys. Required behaviours with tests: the persona
switches at HIGH, the call ends at the limit, both events are logged, and a
disabled setting means BLOCK.
