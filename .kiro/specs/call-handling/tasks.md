# Tasks — call-handling

- [x] Write `lib/twiml.ts`
  - `greetingTwiml(familyName, baseUrl)` — opening `<Gather>` + `<Redirect>` fallback
  - `replyTwiml(text, baseUrl)` — mid-conversation `<Gather>` + `<Redirect>` fallback
  - `connectTwiml(seniorPhone, twilioNumber)` — `<Dial callerId>` to senior
  - `blockTwiml()` — refusal `<Say>` + `<Hangup/>`
  - `messageTwiml()` — unable-to-connect `<Say>` + `<Record>`
  - `timeWasteTwiml(line, baseUrl)` — alias for `replyTwiml`, named for clarity
  - `silenceGoodbyeTwiml()` — goodbye `<Say>` + `<Record>`
  - `errorFallbackTwiml()` — safe fallback for any caught exception

- [x] Write `lib/twilio-validate.ts`
  - `parseFormBody(text)` — decode `application/x-www-form-urlencoded` to plain object
  - `validateTwilioRequest(req)` — read body once, check `X-Twilio-Signature`, throw `TwilioSignatureError` on failure, return parsed params
  - `twimlResponse(xml)` — wrap XML in `Response` with `Content-Type: text/xml`
  - `TwilioSignatureError` class (status 403)

- [x] Write `lib/conversation-engine.ts`
  - `TurnInput` / `TurnOutput` types
  - `runTurn()` stub — returns safe defaults, documented contract for spec 3

- [x] Write `app/api/voice/incoming/route.ts`
  - Validate Twilio signature; 403 on failure
  - Trusted contact → `createCall` (state=completed) + `connectTwiml`
  - Unknown caller → `createCall` (state=screening) + `greetingTwiml`
  - Error catch → `errorFallbackTwiml`

- [x] Write `app/api/voice/turn/route.ts`
  - Validate Twilio signature; 403 on failure
  - Load call + household from DB
  - Append `transcript` event (always, including silent turns)
  - Silence check → `silenceGoodbyeTwiml` after 2 empty turns
  - `runTurn()` → persist `state_change` event + update `calls` row
  - `buildTwiml()` switch on `nextState` → correct TwiML verb
  - Error catch → `errorFallbackTwiml`

- [x] Write `app/api/voice/status/route.ts`
  - Validate Twilio signature; 403 on failure
  - Map `CallStatus` to internal state/outcome
  - Update `calls.state`, `calls.ended_at`, `calls.outcome` (if not set)
  - Respond 204; error catch → 500

- [ ] Replace `runTurn()` stub with Gemini implementation (spec 3)

- [ ] Write `tests/twiml.test.ts`
  - Unit test every builder in `lib/twiml.ts`
  - Verify XML structure with a regex or string parse (no Twilio mock needed)

- [ ] Write `tests/twilio-validate.test.ts`
  - `parseFormBody` — property-based tests with fast-check covering encoding edge cases
  - `validateTwilioRequest` — test 403 path with wrong/missing signature
  - `validateTwilioRequest` — test happy path with `getExpectedTwilioSignature`

- [ ] Write `tests/voice-incoming.test.ts`
  - Trusted contact path: expect `<Dial>` in response body
  - Unknown caller path: expect `<Gather>` in response body
  - Invalid signature: expect 403
  - Missing household: expect `<Record>` in fallback body

- [ ] Write `tests/voice-turn.test.ts`
  - Silence ×2: expect `silenceGoodbyeTwiml` body
  - Happy path each nextState: verify correct TwiML verb in body
  - Invalid signature: expect 403
