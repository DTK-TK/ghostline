# Requirements — time-waster

## Overview

When a call reaches HIGH risk (score ≥ 70) and the household has
`time_waster_enabled = true`, Ghostline switches to a "slow grandmother"
persona designed to occupy the scammer's time without escalating or accusing.
This spec covers the persona, its time limit, and the transition to termination.

---

## R1 — Activation condition

The time-waster persona must activate when ALL of the following are true:

1. The combined risk score reaches HIGH (≥ 70).
2. `households.time_waster_enabled = true` for the household.
3. The call is not already in a terminal state (`scam_blocked`, `completed`,
   `verified`, `transferring`).

When `time_waster_enabled = false`, a HIGH-risk call must go directly to
`scam_blocked` instead.

---

## R2 — Persona description

In time-waster mode, Ghostline's replies must embody a slow, friendly
grandmother character who:

- Mishears what the caller said.
- Mentions looking for her glasses.
- Talks about her cat.
- Responds in short, wandering sentences that do not advance the caller's goal.

The persona must remain warm and never accuse the caller of being a scammer.
The refusal line "I'm not able to connect this call" must still be used if
the caller presses for an outcome.

---

## R3 — Maximum duration

The time-waster persona must run for a maximum of 3 minutes (180 seconds)
from the moment the call enters `time_wasted` state. When the 3-minute limit
is reached, the system must end the call politely (a brief goodbye line
followed by `<Hangup/>`).

The 3-minute timer is tracked using `calls.started_at` and the current wall
time, or by counting turns in `call_events`. Either approach is acceptable as
long as it does not require in-memory state.

---

## R4 — TwiML for time-waster turns

Each time-waster turn must use the same `<Gather>` + `<Redirect>` pattern as
other screening turns (`timeWasteTwiml(line, baseUrl)` from `lib/twiml.ts`),
so the caller continues to be able to speak and Ghostline can respond.

---

## R5 — State transition

The call must enter `time_wasted` state via the standard state machine. The
`state_change` event must be appended to `call_events` as for any other
transition. The turn route handler must route `time_wasted` to
`timeWasteTwiml()` per the state-to-TwiML mapping in the call-handling spec.

---

## R6 — Gemini prompt for time-waster mode

When the call is in `time_wasted` state, the system prompt sent to Gemini
must include the time-waster persona instructions so the model generates
in-character replies. The prompt must specify:

- The grandmother character (mishears, looks for glasses, talks about cat).
- The 3-minute maximum.
- That the persona never accuses or reveals risk information.

---

## R7 — Fallback during time-waster

If Gemini is unavailable while the call is in `time_wasted` state, the engine
must use a scripted grandmother line (not the generic medium/high fallback
reply) so the persona remains consistent.

---

## R8 — Household toggle

The dashboard must expose a toggle for `time_waster_enabled` per household,
allowing family members to turn the feature on or off. The toggle must update
`households.time_waster_enabled` in Supabase. The change takes effect on the
next incoming call; it does not affect calls already in progress.

---

## R9 — No accusation

Regardless of risk score, the time-waster persona must never:

- Tell the caller they are suspected of fraud.
- Use the word "scam" or "fraud".
- Threaten to call police or report the caller.
- Reveal that the call is being recorded or analysed.

The only action taken against HIGH-risk callers (beyond time-wasting) is
silent alerting of family members, covered in the alerts-and-report spec.
