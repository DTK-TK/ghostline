# Design — time-waster

## Overview

The time-waster is a persona mode — not a separate code path. When
`computeNextState()` returns `"time_wasted"`, the same turn loop continues
but the Gemini prompt includes extra persona instructions and the engine
enforces a 3-minute ceiling.

---

## Module layout

No new files are required. The feature extends existing modules:

```
lib/
  conversation.ts       computeNextState() — returns "time_wasted"
                        engine() — passes time-waster context to buildSystemPrompt
  scoring/ai.ts         buildSystemPrompt() — extended with time-waster section
  twiml.ts              timeWasteTwiml() — alias for replyTwiml(), already exists
app/api/voice/
  turn/route.ts         buildTwiml() — routes "time_wasted" to timeWasteTwiml()
app/(dashboard)/
  settings/page.tsx     toggle for households.time_waster_enabled
```

---

## Activation path

```
engine() — combineScores() returns level = "high"
        │
        ▼
computeNextState(current, "high", claimsFamily, timeWasterEnabled)
        │
        ├─ timeWasterEnabled = true  ──► "time_wasted"
        └─ timeWasterEnabled = false ──► "scam_blocked"
```

Once in `time_wasted`, `computeNextState` returns `"time_wasted"` on every
subsequent turn until the timer expires, at which point it returns
`"scam_blocked"`.

---

## 3-minute timer

The timer is calculated from the `state_change` event that recorded the
transition into `time_wasted`:

```typescript
function timeWastedElapsedSeconds(events: CallEventRow[]): number {
  const entry = events
    .filter(e => e.type === "state_change" && e.payload["to"] === "time_wasted")
    .at(-1);
  if (!entry) return 0;
  return (Date.now() - new Date(entry.created_at).getTime()) / 1000;
}
```

This requires no in-memory state. The `call_events` table is the clock.

When `timeWastedElapsedSeconds() >= 180`:

1. `computeNextState` returns `"scam_blocked"`.
2. The engine sets `nextState = "scam_blocked"`.
3. The turn route returns `blockTwiml()` — a polite goodbye + `<Hangup/>`.

---

## Gemini prompt extension

`buildSystemPrompt()` accepts an optional `inTimeWaster: boolean` flag. When
`true`, the system prompt appends:

```
TIME-WASTER MODE IS ACTIVE. You are now a slow, friendly grandmother.
- Mishear what the caller said each turn.
- Mention looking for your glasses.
- Talk about your cat (her name is Marmalade).
- Never advance the caller's stated goal.
- After 3 minutes of this mode, end the call politely: "Oh dear, I must go
  feed Marmalade. Goodbye!"
- Never accuse the caller of fraud or mention risk scores.
```

The model's `reply` field is what `timeWasteTwiml(reply, baseUrl)` will
speak. The `risk_score` and `flags` fields continue to be scored normally so
the event log remains accurate.

---

## Fallback grandmother lines

When Gemini is unavailable and the call is in `time_wasted` state, the engine
uses a rotating list of scripted grandmother lines instead of the generic HIGH
fallback:

```typescript
const GRANDMOTHER_FALLBACKS = [
  "Oh my, hold on dear — I can't find my glasses.",
  "Now where did I put that? Marmalade, get off the phone table!",
  "Could you speak up a little? I'm a bit hard of hearing.",
  "I'm sorry, what was that? I was just feeding the cat.",
  "One moment, I need to sit down. My hip is acting up today.",
];
```

The line is selected by `(turnIndex % GRANDMOTHER_FALLBACKS.length)` where
`turnIndex` is the count of `transcript` events in `call_events`.

---

## TwiML routing

`buildTwiml()` in `app/api/voice/turn/route.ts` already routes `time_wasted`
to `timeWasteTwiml(reply, baseUrl)`, which is an alias for `replyTwiml()` —
a `<Gather>` + `<Redirect>` pair. No TwiML changes needed.

---

## Dashboard toggle

The settings page exposes a shadcn/ui `<Switch>` bound to
`households.time_waster_enabled`. Saving calls a server action or API route
that updates the column. The change takes effect on the next call; calls
already in `time_wasted` are not affected.

```typescript
// PATCH /api/settings/household
{ time_waster_enabled: boolean }
→ updateHousehold(householdId, { time_waster_enabled })
```

---

## Testing strategy

| Test file | What it covers |
|---|---|
| `tests/time-waster.test.ts` | Activation: HIGH + TWE on → time_wasted; HIGH + TWE off → scam_blocked |
| `tests/time-waster.test.ts` | Timer: elapsed < 180 → stays time_wasted; elapsed ≥ 180 → scam_blocked |
| `tests/time-waster.test.ts` | Fallback lines rotate and are in-character (no accusation, no safe-word hint) |
| Manual | Phone the demo number with a scripted HIGH-risk scenario; confirm grandmother replies for up to 3 min then hangs up politely |
