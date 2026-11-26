# Requirements — safe-word-and-callback

## Overview

When a caller claims to be a family member, Ghostline has two defences:
(1) a safe-word challenge the real family member knows, and (2) an outbound
callback to verify the family member is genuinely not calling. This spec
covers both mechanisms and their effect on risk scoring.

---

## R1 — Safe-word challenge trigger

When the AI layer sets `claims_family = true` on any turn, the conversation
engine must transition the call to a safe-word challenge phase. It must prompt
the caller for the safe word without revealing the word, hinting at it, or
confirming whether a previous attempt was close.

Example prompt: "Could you give me the family verification word, please?"

---

## R2 — Safe-word comparison

The safe word submitted by the caller must be:

1. Normalised before comparison (lowercase, leading/trailing whitespace
   stripped).
2. Compared against `households.safe_word_hash` using bcrypt (`crypt(attempt,
   safe_word_hash) = safe_word_hash`). The comparison must never be a
   plaintext equality check.
3. The comparison must happen server-side only; the hash must never be sent to
   the browser or logged.

---

## R3 — Safe-word success

A correct safe word must:

1. Append a `safe_word_attempt` event with `matched = true`.
2. Apply the −40 score adjustment via `combineScores` (floor 0).
3. Transition the call to `verified`.
4. Respond with `connectTwiml()` to ring the senior through.

---

## R4 — Safe-word failure

Each incorrect attempt must:

1. Append a `safe_word_attempt` event with `matched = false`.
2. Add 50 points to the risk score (the `safe_word_fail` flag from
   scam-rules.md) via `combineScores`.
3. Keep the call in `screening` state and ask once more (up to a maximum of
   two attempts).
4. After two failures, treat the call as HIGH risk and apply the standard
   HIGH-risk flow (time-waster or block per `time_waster_enabled`).

---

## R5 — Safe-word not revealed

The system must never:

- Speak, repeat, or hint at the safe word in any voice response.
- Include the safe word in any log line, event payload, or API response.
- Confirm whether the caller's attempt was "close" or "almost right".

---

## R6 — Callback initiation

For any call where `claims_family = true` and the household has at least one
`is_callback_target` family member, the system may initiate an outbound call
via the Twilio REST API to the callback target to verify the caller's claim.
The outbound call:

1. Must use the Twilio account credentials from env vars.
2. Must append a `callback_started` event to `call_events` with
   `target_phone` before dialling.
3. Must handle the case where the callback target does not answer (record a
   `callback_result` event with `outcome = "no_answer"`).

---

## R7 — Callback result: denied

If the family member answers and confirms they are NOT the caller:

1. Append a `callback_result` event with `outcome = "denied"`.
2. Apply the +100 `callback_denied` score via `combineScores`.
3. Transition the call to `scam_blocked` (or `time_wasted` if enabled),
   regardless of a previously correct safe word.

---

## R8 — Callback result: confirmed

If the family member answers and confirms they ARE the caller:

1. Append a `callback_result` event with `outcome = "confirmed"`.
2. No score adjustment.
3. The call may proceed to `verified` and connect to the senior.

---

## R9 — `callback_denied` is irreversible

A correct safe word must never cancel or reduce the score impact of
`callback_denied`. The `combineScores` function enforces this by applying
`callback_denied += 100` before the safe-word credit is applied.

---

## R10 — Privacy of phone numbers

Full phone numbers of family members or the senior must never appear in
`console.log`, `console.error`, or any log sink. They may appear in DB rows
(where they are needed for routing) but must be masked or omitted from
diagnostic output.
