# Tasks — call-handling

Re-planned for the hackathon MVP due Dec 4, 2026. Every task is kept. Decisions are in design.md under "Re-plan decisions".

---

## MVP (build now)

Reason: Everything the Dec 4, 2026 demo needs: a real call through the real engine, safe word and callback checks, the alert and fraud report, and the dashboard to watch it.

- [x] **1.** Write `lib/twiml.ts`
  - `greetingTwiml(familyName, baseUrl)` — opening `<Gather>` + `<Redirect>` fallback
  - `replyTwiml(text, baseUrl)` — mid-conversation `<Gather>` + `<Redirect>` fallback
  - `connectTwiml(seniorPhone, twilioNumber)` — `<Dial callerId>` to senior
  - `blockTwiml()` — refusal `<Say>` + `<Hangup/>`
  - `messageTwiml()` — unable-to-connect `<Say>` + `<Record>`
  - `timeWasteTwiml(line, baseUrl)` — alias for `replyTwiml`, named for clarity
  - `silenceGoodbyeTwiml()` — goodbye `<Say>` + `<Record>`
  - `errorFallbackTwiml()` — safe fallback for any caught exception
  - _MVP, done: Already built and reachable from the live routes._

- [x] **2.** Write `lib/twilio-validate.ts`
  - `parseFormBody(text)` — decode `application/x-www-form-urlencoded` to plain object
  - `validateTwilioRequest(req)` — read body once, check `X-Twilio-Signature`, throw `TwilioSignatureError` on failure, return parsed params
  - `twimlResponse(xml)` — wrap XML in `Response` with `Content-Type: text/xml`
  - `TwilioSignatureError` class (status 403)
  - _MVP, done: Already built and reachable from the live routes._

- [x] **3.** Write `lib/conversation-engine.ts`
  - `TurnInput` / `TurnOutput` types
  - `runTurn()` stub — returns safe defaults, documented contract for spec 3
  - _MVP, done: Built, but the stub is replaced in build item 1._
  - _Note: `lib/conversation-engine.ts` was intentionally replaced by `lib/conversation.ts` (`engine()`), so the file no longer exists._

- [x] **4.** Write `app/api/voice/incoming/route.ts`
  - Validate Twilio signature; 403 on failure
  - Trusted contact → `createCall` (state=completed) + `connectTwiml`
  - Unknown caller → `createCall` (state=screening) + `greetingTwiml`
  - Error catch → `errorFallbackTwiml`
  - _MVP, done: Already built and reachable from the live routes._

- [x] **5.** Write `app/api/voice/turn/route.ts`
  - Validate Twilio signature; 403 on failure
  - Load call + household from DB
  - Append `transcript` event (always, including silent turns)
  - Silence check → `silenceGoodbyeTwiml` after 2 empty turns
  - `runTurn()` → persist `state_change` event + update `calls` row
  - `buildTwiml()` switch on `nextState` → correct TwiML verb
  - Error catch → `errorFallbackTwiml`
  - _MVP, done: Built; the silence rule is fixed in build item 1._

- [x] **6.** Write `app/api/voice/status/route.ts`
  - Validate Twilio signature; 403 on failure
  - Map `CallStatus` to internal state/outcome
  - Update `calls.state`, `calls.ended_at`, `calls.outcome` (if not set)
  - Respond 204; error catch → 500
  - _MVP, done: Already built and reachable from the live routes._

- [x] **7.** Replace `runTurn()` stub with Gemini implementation (spec 3)
  - _MVP, build item 1: Same work as conversation-and-scoring task 1; do it once, there._

- [x] **11.** Write `tests/voice-turn.test.ts`
  - Silence ×2: expect `silenceGoodbyeTwiml` body
  - Happy path each nextState: verify correct TwiML verb in body
  - Invalid signature: expect 403
  - _MVP, build item 1: Proves the silence fix and each next state on the live route._
  - _Re-plan: tests/voice-turn.test.ts already exists; extend it. One empty turn replies and keeps gathering; the call hangs up after two consecutive empty turns._

---

## Deferred (post-hackathon)

Reason: Not needed to show the demo (the demo household is seeded with SQL), so these wait until after the hackathon.

- [ ] **8.** Write `tests/twiml.test.ts`
  - Unit test every builder in `lib/twiml.ts`
  - Verify XML structure with a regex or string parse (no Twilio mock needed)
  - _Deferred: The builders are already exercised through the route tests._

- [ ] **9.** Write `tests/twilio-validate.test.ts`
  - `parseFormBody` — property-based tests with fast-check covering encoding edge cases
  - `validateTwilioRequest` — test 403 path with wrong/missing signature
  - `validateTwilioRequest` — test happy path with `getExpectedTwilioSignature`
  - _Deferred: The 403 path is covered by the route tests; the extra property tests can follow._

- [ ] **10.** Write `tests/voice-incoming.test.ts`
  - Trusted contact path: expect `<Dial>` in response body
  - Unknown caller path: expect `<Gather>` in response body
  - Invalid signature: expect 403
  - Missing household: expect `<Record>` in fallback body
  - _Deferred: tests/voice-incoming.test.ts already exists and passes; extend it later._
