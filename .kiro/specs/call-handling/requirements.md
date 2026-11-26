# Requirements — call-handling

## Overview

Every inbound call to the Ghostline Twilio number passes through three HTTP
webhooks. This spec covers those webhooks, the state machine they drive, and
the TwiML responses they produce. It does not cover the conversation engine
(spec 3) or alerting (covered separately); those are dependencies called from
here.

---

## R1 — Signature validation on every webhook

Every `POST /api/voice/*` route must validate the `X-Twilio-Signature`
header using `validateRequest()` from the `twilio` npm package before
touching any application logic. A missing or invalid signature must return
HTTP 403 with no TwiML body.

The validation URL must be built from `PUBLIC_BASE_URL` + the request path,
matching the exact URL registered in the Twilio console.

---

## R2 — POST /api/voice/incoming: trusted-contact fast path

When `From` matches a phone number in the household's `contacts` table, the
route must:

1. Create a `calls` row with `state = completed`, `outcome = transferred`.
2. Respond immediately with `<Dial callerId="{TWILIO_PHONE_NUMBER}"><Number>{senior_phone}</Number></Dial>`.

No screening, no greeting, no AI involvement.

---

## R3 — POST /api/voice/incoming: unknown caller screening path

When `From` is not a trusted contact, the route must:

1. Look up the household by the dialled `To` number.
2. Create a `calls` row with `state = screening`.
3. Respond with:

```xml
<Response>
  <Gather input="speech" speechTimeout="auto"
          action="/api/voice/turn" method="POST">
    <Say>You've reached the {family_name} residence. This call is
    screened by Ghostline. Please say your name and why you're
    calling.</Say>
  </Gather>
  <Redirect method="POST">/api/voice/turn</Redirect>
</Response>
```

The `<Redirect>` fallback ensures that silence (no speech detected) also
posts to `/api/voice/turn` so the silence counter can increment.

---

## R4 — POST /api/voice/turn: transcript persistence

On every call to `/api/voice/turn` the route must:

1. Read `SpeechResult` from the form body (empty string if the caller was
   silent).
2. Append a `transcript` event to `call_events` with
   `speaker = "caller"` and `text = SpeechResult` (even when empty).

---

## R5 — POST /api/voice/turn: silence handling

If `SpeechResult` is empty on two or more consecutive turns, the route must:

1. Update `calls.state = completed`, `calls.outcome = dropped`.
2. Append a `state_change` event.
3. Respond with `<Say>` (goodbye) followed by `<Record>` (take a message).

Consecutive silence is detected without an extra DB query on the hot path;
the conversation engine (spec 3) may refine this with a full event-log scan.

---

## R6 — POST /api/voice/turn: conversation engine delegation

For turns where speech is present (or first silence), the route must:

1. Call `runTurn({ callSid, speechResult, currentState, currentRiskScore })`.
2. Receive `{ reply, nextState, riskUpdate }`.
3. If `nextState ≠ currentState`, append a `state_change` event.
4. Update `calls.state`, `calls.risk_score` (monotonically increasing),
   `calls.risk_level`.

---

## R7 — POST /api/voice/turn: state-to-TwiML mapping

| `nextState`              | TwiML returned |
|--------------------------|----------------|
| `screening` (or `initiated`) | `<Gather>` with persona reply, `<Redirect>` fallback |
| `time_wasted`            | `<Gather>` with grandmother line, `<Redirect>` fallback |
| `verified` or `transferring` | `<Dial>` to senior_phone |
| `scam_blocked`           | `<Say>` refusal line + `<Hangup/>` |
| `completed`              | `<Say>` + `<Record>` (voicemail) |

---

## R8 — POST /api/voice/status: call finalisation

When Twilio fires the StatusCallback:

1. Validate signature (R1).
2. Set `calls.state` and `calls.ended_at = now()`.
3. Set `calls.outcome` only if the turn handler has not already set one.
4. Respond HTTP 204 (no body). Twilio ignores the body of status callbacks.

Twilio `CallStatus` → internal mapping:

| Twilio status | `calls.state` | `calls.outcome` |
|---|---|---|
| completed | completed | transferred *(if not already set)* |
| busy | completed | dropped |
| failed | failed | unknown |
| no-answer | completed | dropped |
| canceled | completed | dropped |

---

## R9 — Error safety within 10 seconds

Every route must:

- Wrap all application logic in a `try/catch`.
- On any caught error, return `errorFallbackTwiml()` (a `<Say>` + `<Record>`
  that takes a voicemail) so the caller never hears dead air and the senior
  never misses a legitimate message.
- The incoming and turn routes must complete the happy path in under 10 s
  (Twilio's webhook timeout). The conversation engine prompt budget is set
  accordingly in spec 3.

---

## R10 — No in-memory state

All call state lives in the `calls` and `call_events` tables, keyed by
`CallSid`. Route handlers must not cache anything in module-scope variables
between requests. This is required because Vercel serverless functions do not
share memory across invocations.
