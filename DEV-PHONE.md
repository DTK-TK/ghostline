# Dev Phone — `/dev/phone`

## Overview

A browser-based phone simulator that calls the same code paths as real Twilio webhooks, allowing full end-to-end testing without a live phone or Twilio account.

**URL:** `/dev/phone`  
**Gate:** `devToolsEnabled()` in `lib/dev-gate.ts`. Enabled only when `VERCEL_ENV` is not `production` AND (`ENABLE_DEV_TOOLS=true` OR `NODE_ENV=development`). So local `next dev` works; a Vercel preview returns 404 unless `ENABLE_DEV_TOOLS=true` is set; production is always 404.

---

## Features

✅ **Call initiation**  
   Pick a household from the dropdown and press **Call** to start a screening conversation.

✅ **Typed or spoken input**  
   Type what the caller says, or hold the **Talk** button to use the browser's Web Speech API (SpeechRecognition). Recognized speech is sent as a turn to the conversation engine.

✅ **Ghostline replies**  
   Appear as chat bubbles and are read aloud with `speechSynthesis`.

✅ **Callback simulation**  
   When the conversation engine detects `claims_family = true` and starts a callback, a card appears with three buttons:
   - ✅ **It's me (press 1)** — family member confirms
   - 🚫 **Not me (press 2)** — family member denies (+100 risk, call blocked)
   - 📵 **No answer** — no callback result

✅ **Mock Inbox panel (right side)**  
   Shows every SMS and `callback_call` row written by `MockTelephony` to the `mock_messages` table. Polls every 3 seconds for new entries. Phone numbers show only the last 4 digits (privacy rule from privacy.md).

✅ **Debug panel**  
   Shows current state, risk score (with colour + text label per ui.md accessibility rule), and detected flags.

✅ **Reuses real DB tables**  
   Calls are written to the `calls` and `call_events` tables exactly as they would be in production, so the Live dashboard (when built) will update in real time.

---

## UI (follows ui.md)

- **Dark theme** throughout (zinc-950 background, zinc-800 panels, zinc-700 borders).
- **Header:** cassette-tape icon + `"GHOSTLINE"` in monospace + amber `"DEV PHONE"` badge.
- **Risk indicators:** colour swatch + text label (e.g., `"HIGH"` in red) for accessibility.
- **Layout:** two-column — chat + controls on the left, mock inbox on the right.

---

## API Routes

All routes return 404 unless `devToolsEnabled()` is true (see Gate above).

### `POST /api/dev/phone/start`
Starts a call. Replicates `/api/voice/incoming` logic without Twilio signature validation or TwiML.

**Body:**
```json
{ "fromNumber": "+15550009999", "householdPhone": "+15550000000" }
```

**Response:**
```json
{
  "callSid": "DEV_1234567890_ABC123",
  "callId": "uuid",
  "reply": "You've reached the Sun residence. …",
  "state": "screening",
  "trusted": false
}
```

### `POST /api/dev/phone/turn`
Processes one spoken turn. Calls the conversation engine (`lib/conversation.ts`).

**Body:**
```json
{ "callSid": "DEV_...", "speechResult": "Hi, I need to talk to grandma." }
```

**Response:**
```json
{
  "reply": "Thank you. Could you tell me your name?",
  "state": "screening",
  "riskScore": 15,
  "riskLevel": "low",
  "flags": [],
  "callbackPending": { "name": "family member", "phone": "+1…", "originalCallSid": "…" }
}
```

### `POST /api/dev/phone/callback-answer`
Simulates the family member answering the callback call and pressing a DTMF digit.

**Body:**
```json
{ "callSid": "DEV_...", "digit": "2" }
```

**Response:**
```json
{
  "outcome": "denied",
  "riskScore": 100,
  "riskLevel": "high",
  "state": "scam_blocked"
}
```

Digit mapping:
- `"1"` → confirmed (it's me) — no score change
- `"2"` → denied (not me) — +100 penalty, state → `scam_blocked`
- `"0"` → no answer — no score change

### `GET /api/dev/phone/inbox[?since=ISO8601]`
Returns all rows from `mock_messages`, newest first. Optional `since` param for polling.

**Response:**
```json
{
  "messages": [
    {
      "id": "uuid",
      "to_number": "+15551112222",
      "body": "GHOSTLINE HIGH: Caller claimed to be grandson. …",
      "kind": "sms",
      "created_at": "2026-01-01T12:00:00Z"
    },
    {
      "id": "uuid",
      "to_number": "+15553334444",
      "body": "{\"originalCallSid\":\"DEV_...\",\"claimedName\":\"Tommy\"}",
      "kind": "callback_call",
      "created_at": "2026-01-01T12:01:00Z"
    }
  ]
}
```

---

## Usage

1. **Start the dev server:**
   ```bash
   npm run dev
   ```

2. **Set env vars for mock mode:**
   ```bash
   MOCK_TELEPHONY=true
   AI_PROVIDER=mock
   ```

3. **Seed the demo household:**
   ```bash
   npx supabase db seed
   ```

4. **Open the phone:**
   ```
   http://localhost:3000/dev/phone
   ```

5. **Run a call:**
   - Select "Sun" household
   - Enter a caller number (e.g., `+15550009999`)
   - Press **Call**
   - Type or speak a scam script (e.g., "Hi, it's your grandson, I need bail money")
   - Watch the risk score climb, flags appear, and SMS alerts land in the Mock Inbox
   - If the caller claims to be family, a callback card appears — press **Press 2 (not me)** to deny and trigger the +100 penalty

---

## Browser compatibility

- **Chrome / Edge:** Full support (SpeechRecognition, speechSynthesis).
- **Firefox:** speechSynthesis only; SpeechRecognition is not available (type input still works).
- **Safari:** speechSynthesis + limited SpeechRecognition support (may require user gesture).

The page degrades gracefully: if SpeechRecognition is unavailable, a system message appears and the Talk button is disabled. Text input always works.

---

## Files created

```
app/
  dev/phone/
    page.tsx               server wrapper (production gate + household loader)
    phone-client.tsx       full client UI (chat, speech, inbox)

app/api/dev/phone/
  start/route.ts           POST /api/dev/phone/start
  turn/route.ts            POST /api/dev/phone/turn
  callback-answer/route.ts POST /api/dev/phone/callback-answer
  inbox/route.ts           GET  /api/dev/phone/inbox
```

---

## Testing checklist

- [x] Page returns 404 when `VERCEL_ENV=production` or on preview without `ENABLE_DEV_TOOLS=true`
- [x] Call start creates a `calls` row with a `DEV_` CallSid
- [x] Typed input → turn → reply → chat bubble + spoken aloud
- [x] Hold Talk button → SpeechRecognition → transcript → turn
- [x] Callback card appears when `claims_family = true`
- [x] Press 2 (denied) → +100 penalty → `scam_blocked`
- [x] Mock Inbox polls every 3 s and shows SMS alerts
- [x] Debug panel shows state/score/flags with colour + text label
- [x] All routes pass TypeScript strict mode
- [x] No direct `twilio` or `@google/genai` imports outside `lib/providers`

---

## Next steps

Once the dashboard is built (`app/(dashboard)/page.tsx`), open it in a second browser tab while running a dev phone call and confirm the call list updates in real time via Supabase Realtime.
