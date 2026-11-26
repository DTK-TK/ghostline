# Design — call-handling

## Re-plan decisions (hackathon MVP, due Dec 4, 2026)

- The live `/api/voice/turn` route calls the real engine through `processTurn()`. The stub in `lib/conversation-engine.ts` is removed (conversation-and-scoring task 1).
- The "Silent-turn handling" rule is: one silent turn replies and keeps gathering; two consecutive silent turns hang up. The count comes from `call_events`, not from the request.
- The status route ends calls through `finalizeCall()`.
- **Deferred:** twiml and twilio-validate unit tests (tasks 8, 9) and extra incoming tests (task 10).

## State machine

```
INCOMING CALL
     │
     ▼
[/incoming]──trusted contact?──YES──► CONNECT (Dial → senior)
     │
     NO
     ▼
  GREETING ──────────────────────────────────────────────────────┐
  (create calls row, state=screening)                             │
  <Gather> opening line                                           │
     │ SpeechResult (or silence → Redirect)                      │ silence×2
     ▼                                                            │
[/turn] ◄────────────────────────────────────────────────────────┘
     │
     ├─ silence ×2 ──────────────────────► goodbye + <Record> (ENDED)
     │
     ▼
  runTurn() → { reply, nextState, riskUpdate }
     │
     ├─ nextState = screening ──────────► <Gather> reply (IDENTIFY / SCREEN)
     │
     ├─ nextState = time_wasted ────────► <Gather> grandmother line (TIME_WASTE)
     │
     ├─ nextState = verified/transferring ► <Dial> senior (CONNECT → ENDED)
     │
     ├─ nextState = scam_blocked ───────► <Say> refusal + <Hangup> (BLOCK → ENDED)
     │
     └─ nextState = completed ──────────► <Say> + <Record> (MESSAGE → ENDED)

[/status] fires when Twilio closes the leg → ended_at stamped, final state written
```

## File layout

```
lib/
  twiml.ts                 Pure TwiML string builders (no I/O)
  twilio-validate.ts       validateTwilioRequest(), twimlResponse(), TwilioSignatureError
  conversation-engine.ts   runTurn() — stub (spec 3 replaces the body)

app/api/voice/
  incoming/route.ts        POST /api/voice/incoming
  turn/route.ts            POST /api/voice/turn
  status/route.ts          POST /api/voice/status
```

## Signature validation

Twilio signs webhooks with HMAC-SHA1 over (URL + sorted-param-pairs) using
the account Auth Token. `validateTwilioRequest()` from the `twilio` package
handles the cryptography; our `lib/twilio-validate.ts` handles extracting the
raw URL, parsing the `application/x-www-form-urlencoded` body, and threading
the values through.

Body is consumed once from the stream, then passed to the route as a plain
`Record<string,string>`. The route handler never reads `req.text()` or
`req.formData()` itself.

The URL reconstructed for validation is: `PUBLIC_BASE_URL + pathname + search`.
`PUBLIC_BASE_URL` must not have a trailing slash.

## Silent-turn handling

Twilio's `<Gather speechTimeout="auto">` posts to `action` when it detects
end-of-speech. If the caller says nothing, it times out and falls through to
the `<Redirect method="POST">` that follows the `<Gather>` — this re-posts
to `/api/voice/turn` with an empty `SpeechResult`.

The turn handler detects silence by checking `SpeechResult === ""` and
tracking whether the call is already in a non-initial state. After two
consecutive empty turns it plays a goodbye and records a voicemail.

The spec 3 conversation engine may refine silence counting using a full
query over `call_events` of type `transcript` with empty `text`.

## Conversation engine interface

The turn route handler depends on `runTurn()` from
`lib/conversation-engine.ts`. The contract:

```typescript
interface TurnInput {
  callSid: string;         // load history from call_events
  speechResult: string;    // current caller utterance
  currentState: CallState;
  currentRiskScore: number;
}

interface TurnOutput {
  reply: string;           // persona text to <Say>
  nextState: CallState;    // drives the TwiML switch
  riskUpdate: { score: number; level: RiskLevel };
}
```

The stub returns `{ reply: "...", nextState: "screening", riskUpdate: { score: 0, level: "low" } }`
so the full webhook pipeline can be exercised before spec 3 is built.

## Risk score persistence

`calls.risk_score` is monotonically increasing: the turn handler writes
`Math.max(riskUpdate.score, call.risk_score ?? 0)`. The AI engine may raise
a score, never lower it (per scam-rules.md).

## TwiML as pure functions

All TwiML is generated in `lib/twiml.ts` without any database access.
Route handlers gather the data they need, then call a twiml builder.
This makes every TwiML shape unit-testable with no mocks.

## Error budget

| Step | Expected time |
|---|---|
| Twilio signature validation | < 1 ms |
| Household / contact lookup (Supabase) | < 200 ms |
| `createCall` / `updateCall` | < 100 ms |
| `appendEvent` | < 100 ms |
| `runTurn()` (Gemini, spec 3) | < 7 s budget |
| TwiML build | < 1 ms |
| **Total** | **< 10 s** |

The Gemini prompt budget (spec 3) must stay within ~7 s to leave headroom
for DB round-trips and cold-start latency on Vercel.
