# Requirements: safe-word-and-callback

## Overview

A voice clone can copy a voice but not a secret. When a caller claims to be
family, Ghostline has two defences:

1. A safe-word challenge. The caller must say the household's family word.
2. A callback. Ghostline phones a family member and asks whether they are
   really the one calling.

Sources of truth: `scam-rules.md`, `voice-persona.md`, `privacy.md`,
`tech.md`, `product.md`. Ghostline never promises deepfake detection. The safe
word is the defence.

Scoring rules (`combineScores`, owned by the conversation-and-scoring spec):
each failed safe-word attempt adds 50 (`safe_word_fail`), a correct word
subtracts 40 (floor 0), `callback_denied` adds 100, and a correct word never
cancels `callback_denied`.

---

## R1. Challenge trigger and prompt

- When the caller claims to be family on a turn (`claims_family = true` from
  the AI layer, or a deterministic pattern match when the AI is unavailable)
  and the household has a `safe_word_hash`, Ghostline asks exactly:
  "What's the family word?"
- The challenge is asked once per call. A retry uses a neutral line:
  "Sorry, I didn't catch that. What's the family word?"
- Replies never confirm whether an answer was close, and never say whether
  a word exists in a particular format or length.

---

## R2. Normalisation

The same function normalises the stored word (at setup) and every attempt:

1. lowercase
2. trim
3. strip punctuation (keep letters, digits and inner spaces; collapse spaces)
4. singularise each word ("pumpkins" becomes "pumpkin")

A spoken lead-in ("it's", "the word is", "the family word is") is removed
before comparison. At most 2 bcrypt comparisons are made per attempt (the
full normalised text, and the text without the lead-in). No fuzzy or
near-match logic is allowed.

---

## R3. Comparison

- The attempt is compared with `bcryptjs` against `households.safe_word_hash`.
  Plaintext equality is never used.
- Comparison runs only on the server. The hash never reaches the browser,
  logs, events or API responses.
- Hashes with the `$2a$`, `$2b$` or `$2y$` prefix must verify (see the hash
  compatibility note in design.md).
- An invalid or missing hash counts as a failed attempt and logs an error
  without the hash.

---

## R4. Success

A correct word:

1. appends a `safe_word_attempt` event with `matched: true`;
2. subtracts 40 from the score (floor 0). The credit is never cancelled by
   the monotonic floor (see R11) and never cancels `callback_denied`;
3. moves the call to `verified` and rings the senior through, unless the
   final level is HIGH (for example after a denied callback). In that case
   the HIGH flow applies.

---

## R5. Failure

Each wrong or refused attempt (including "I don't know" and silence during
the challenge):

1. appends a `safe_word_attempt` event with `matched: false`;
2. adds 50 points (`safe_word_fail`);
3. keeps the call in `screening` and asks once more after the first failure.

After the second failure the score is at least 100, which is HIGH. The HIGH
flow applies: `time_wasted` if the household has the time-waster on,
otherwise `scam_blocked`, with "I'm not able to connect this call."

---

## R6. The safe word is never exposed

- No voice reply, log line, event payload or API response contains the safe
  word, the hash, or a hint about it.
- The caller's attempt is never stored in plaintext. `safe_word_attempt`
  events store `attempt: "[redacted]"`. The transcript event for that turn
  is stored as "[safe word attempt]". The attempt is never sent to Gemini
  and never fed to the rules layer.
- The challenge turn is handled before the transcript is written and before
  any AI call.

---

## R7. Callback initiation

When the caller claims to be a named family member (`claims_family` and a
non-empty `claimed_identity`) and the household has a family member with
`is_callback_target = true`:

1. Ghostline appends a `callback_started` event (with the target phone, never
   logged) before dialling.
2. It places an outbound call through the telephony provider
   (`getTelephony().startCallbackCall`) to the first callback target. This
   works with Twilio and with `MockTelephony`.
3. The family member hears:
   "This is Ghostline. Someone saying they are <name> is calling <family
   name> right now. Press 1 if you are safe and NOT calling. Press 2 if it
   really is you."
4. At most one callback is started per call.
5. `<name>` is the claimed name cut to 40 characters of letters, spaces,
   hyphens and apostrophes. Nothing else from the caller's speech is spoken.
6. If no target exists, or placing the call fails, record
   `callback_result` with `no_answer` (no score change) and carry on.

The order of the safe-word question and the callback is an open decision
(see design.md). The default is: the callback is placed on the claim turn,
in the same reply that asks for the family word.

---

## R8. Callback results

| Event | Outcome | Effect |
|---|---|---|
| Press 1 | `denied` | +100, HIGH, HIGH flow |
| Press 2 | `confirmed` | subtract 40 (floor 0) |
| Timeout, busy, no answer, failed, hang-up | `no_answer` | no change |

- Any other digit repeats the prompt once, then counts as `no_answer`.
- The first result for a callback wins. Twilio retries and later status
  callbacks must not write a second `callback_result`.
- A denied result can never be reversed by a correct word or a later
  confirmation.
- A result that arrives after the call ended is still recorded and
  escalates the alert, but cannot reconnect or disconnect the call.

---

## R9. Holding the caller

While a callback is pending (a `callback_started` with no later
`callback_result`), the caller hears "Please hold one moment", then a
10-second pause, then Twilio redirects to `POST /api/voice/hold-check`.
`hold-check` loops at most 4 times (about 45 seconds in total):

- Result is `denied`: HIGH flow.
- Result is `confirmed`: re-score and continue (connect if LOW).
- Still pending after the 4th check: record `no_answer`, say
  "Thank you for waiting.", and continue screening without the callback.

Hold state is read from the database. The loop count travels in the
redirect URL (`?n=1` to `?n=4`), which Twilio signs.

---

## R10. Webhook rules

Every route here validates `X-Twilio-Signature` (403 on failure), answers
within 10 seconds, holds no business logic (it lives in `lib/`), and returns
safe TwiML on any error (the caller never hears silence).

---

## R11. Score interaction

- `callbackDenied` and `safeWordCorrect` are derived from `call_events`,
  never hardcoded.
- Credits (−40 for a correct word, −40 for a confirmed callback) must not be
  cancelled by the monotonic floor. The floor applies to the score before
  credits.
- `callback_denied` always yields HIGH.

---

## R12. Privacy

- Full phone numbers never appear in `console.*` output. Use a masked form.
- The safe word, its hash and caller attempts never appear in logs.
- Demo data uses fake names and teammates' verified numbers only.
- Callback and alert flows never auto-submit anything to police or CAFC.

---

## R13. Verification

- Tests run without Twilio, Gemini or Supabase credentials.
- Unit tests use real bcryptjs hashes (cost 4 in tests) so match and mismatch
  are both exercised.
- Required behaviours with tests: a correct word lowers the score by 40, a
  denied callback forces HIGH, `no_answer` changes nothing, both new routes
  validate the signature and write the right events.
