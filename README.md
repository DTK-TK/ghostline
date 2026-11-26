# Ghostline

Ghostline is a resurrected 1980s answering machine for seniors. Every call reaches Ghostline first: known contacts ring straight through, and unknown callers are screened by an AI voice that scores the call for scam signals and alerts the family. It is our entry for Kiroween 2026, Resurrection category (dead tech brought back to life).

Ghostline never claims to detect deepfake voices. The defence is the family safe word: a voice clone can copy a voice but not a secret.

## How it works

1. **Known contacts.** If the caller's number is a trusted contact of the household, the call is dialed straight through to the senior.
2. **AI screening.** Every other call is answered with the opening line "You've reached the <family name> residence. This call is screened by Ghostline. Please say your name and why you're calling." The AI asks who is calling and why, and each turn is scored by a rules layer plus one Gemini call. The score is the higher of the two. Bands: LOW 0-39, MEDIUM 40-69, HIGH 70 and up. The AI can raise a score, never lower it.
3. **Safe word challenge.** A caller who claims to be family is asked for the family safe word. The word is stored only as a bcrypt hash and is never repeated or hinted at. A correct word subtracts 40 from the score. A wrong or refused word adds 50 per failure.
4. **Callback check.** Ghostline can phone a family member marked as a callback target and ask whether they are really the one calling (press 1 for yes, 2 for no). A denial forces HIGH. A confirmation lowers the score by 40. No answer changes nothing.
5. **Time-waster persona.** On a HIGH call, if the household has the setting on, a slow, chatty grandmother keeps the caller talking for at most 3 minutes, then ends the call politely. With the setting off, a HIGH call is blocked with "I'm not able to connect this call."
6. **Alert SMS and money-move checklist.** On MEDIUM or HIGH, every family member with alerts on gets one SMS (320 characters at most) with a dashboard link. If the caller mentioned a payment method, they also get a second SMS with four steps: call the contact first, send no more money, a step chosen by payment type, and keep receipts.
7. **Fraud report.** After a HIGH call Ghostline builds a report at `/reports/[id]`, with a copy-ready text block for the Canadian Anti-Fraud Centre (CAFC) form. Nothing is ever submitted automatically; the family files it. Simulated calls never produce a fileable report.
8. **Family dashboard.** Passcode-protected pages: **Live** (the call happening now, transcript, red-flag chips, risk meter, safe word and callback status, time-wasted timer), **Calls** (history) and call details. Live pages poll the server every 2 seconds. A Settings page is designed but deferred (see `.kiro/specs/dashboard-and-simulator`).

Every screened call announces that it is screened. Ghostline never accuses a caller of being a scammer.

## Tech stack

- Next.js 16.4.6 (App Router), React 19, TypeScript, deployed on Vercel. API routes are the backend.
- Twilio Programmable Voice (TwiML: `<Gather input="speech">`, `<Say>`, `<Dial>`), REST API for outbound calls and SMS. Every Twilio webhook validates `X-Twilio-Signature`.
- Google Gemini `gemini-2.5-flash` through `@google/genai`, JSON output validated with zod.
- Supabase Postgres. Server code uses the service role key. Conversation state lives in the database keyed by Twilio CallSid.
- Tailwind CSS 4, shadcn-style components, dark theme.
- Tests: vitest and fast-check (property-based tests).
- All external services go through `lib/providers`, which has mocks for telephony and AI. Production refuses to start with a mock provider.

## Run locally

Requirements: Node.js and npm, a Supabase project. Twilio and Gemini accounts are optional in test mode (see below).

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your env file and fill it in:

   ```bash
   cp .env.example .env.local
   ```

   | Variable | What it is |
   | --- | --- |
   | `TWILIO_ACCOUNT_SID` | Twilio account SID. Not needed with `MOCK_TELEPHONY=true`. |
   | `TWILIO_AUTH_TOKEN` | Twilio auth token, used to send SMS and to validate webhook signatures. Keep it secret. |
   | `TWILIO_PHONE_NUMBER` | The Twilio number that receives calls and sends SMS. |
   | `GEMINI_API_KEY` | Google Gemini API key. Not needed with `AI_PROVIDER=mock`. |
   | `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL. |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key for the browser client. Row level security is on with no policies, so it reads nothing. |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key. Server only. Never expose it. |
   | `PUBLIC_BASE_URL` | Public URL of the app. It goes into Twilio redirects and the dashboard link in SMS. |
   | `MOCK_TELEPHONY` | Commented out by default. `true` uses mock telephony (logs plus the `mock_messages` table) instead of Twilio. Dev only. |
   | `AI_PROVIDER` | Commented out by default. `gemini` (default when unset), `ollama` or `mock`. `ollama` and `mock` are dev only. |
   | `OLLAMA_URL`, `OLLAMA_MODEL` | Commented out by default. Ollama endpoint (`http://localhost:11434`) and model (`llama3.2`) when `AI_PROVIDER=ollama`. |
   | `TIME_WASTER_SECONDS` | Maximum seconds the grandmother persona keeps a HIGH-risk caller. Default 180. Larger values are clamped to 180. Invalid or non-positive values fall back to 180. |
   | `ENABLE_SIMULATOR` | `true` enables the "Simulate a call" button and `/api/simulate` (demo household only). Keep `false` in production unless you want the demo. |
   | `ENABLE_DEV_TOOLS` | `true` enables `/dev/phone` and `/api/dev/phone/*` outside local development. Always off when `VERCEL_ENV=production`. |
   | `SIMULATOR_SAFE_WORD` | The safe word the simulator's scripted caller says. A demo value only, never a real family safe word. |
   | `DASHBOARD_PASSCODE` | Passcode for the dashboard. Required: the dashboard stays closed if unset. |

   Production refuses to start with `MOCK_TELEPHONY=true`, `AI_PROVIDER=mock` or `ollama`, or an unknown `AI_PROVIDER`.

   For a no-Twilio, no-Gemini test setup, set `MOCK_TELEPHONY=true` and `AI_PROVIDER=mock`.

3. Apply the database migrations in order, in the Supabase SQL editor (or with the Supabase CLI):

   ```
   supabase/migrations/0001_initial_schema.sql
   supabase/migrations/0002_mock_messages.sql
   supabase/migrations/0003_call_evidence.sql
   supabase/migrations/0004_dashboard.sql
   supabase/migrations/0005_alert_unique.sql
   supabase/migrations/0006_fraud_report_unique.sql
   ```

4. Load the demo household with `supabase/seeds/demo.sql`. It creates household "Sun" (marked `is_demo`), two family members who get alerts, one trusted contact, and a bcrypt-hashed demo safe word. Phone numbers are placeholders unless you set `app.seed_member1_phone` and the other `app.seed_*` settings listed at the top of the file. Use only teammates' verified numbers. Edit `v_safe_word` in the seed if you want a different demo word.

5. Start the app:

   ```bash
   npm run dev
   ```

6. Open the pages:
   - `/dev/phone`: a browser phone that runs the real conversation engine with no Twilio call. Type or speak as the caller. A Mock Inbox panel shows the SMS and callback rows (numbers show the last four digits only). Available in local development, or when `ENABLE_DEV_TOOLS=true`. See `DEV-PHONE.md`.
   - `/live`: the family dashboard. Enter `DASHBOARD_PASSCODE` on the unlock page first. `/calls` lists past calls.

To take real calls, point your Twilio number's voice webhook at `POST <PUBLIC_BASE_URL>/api/voice/incoming` and its status callback at `<PUBLIC_BASE_URL>/api/voice/status`.

## For judges

Fill in the placeholders below before submitting.

- **Demo phone number:** <TO FILL>
- **Dashboard URL:** <TO FILL>
- **Dashboard passcode:** <TO FILL>
- **Demo safe word:** <TO FILL>

**Simulate button (no phone needed).**

1. Open the dashboard URL, enter the passcode, and go to **Live**.
2. Click **Simulate a call** and choose a scenario: Grandparent scam, CRA tax scam, Bank and tech support scam, Legitimate doctor's office, or Real grandchild with the safe word.
3. Watch the caller lines arrive about every 1.5 seconds with Ghostline's replies. The page shows a **SIMULATED** badge, red-flag chips with the caller's quoted words, the risk meter (with a text label, not colour only), and safe word and callback status.
4. Family alert SMS for simulated calls start with `SIMULATED:`. With mock telephony they appear in the Mock Inbox on `/dev/phone`.
5. Open **Calls** to see the call with a SIMULATED badge. Scam calls that reach HIGH get a **Report** link.

The simulator needs `ENABLE_SIMULATOR=true`, the seeded demo household, and is limited to one run per household every 30 seconds and 50 per 24 hours. Expected outcomes (asserted in `tests/simulate.test.ts` and `tests/simulate-e2e.test.ts`, with the mock AI):

| Scenario | Result |
| --- | --- |
| Grandparent scam | Ends HIGH. One `SIMULATED: GHOSTLINE HIGH` SMS per family member, once. A checklist SMS (`GHOSTLINE STEPS`) per family member. One fraud report stored. |
| CRA tax scam | Ends HIGH. |
| Bank and tech support scam | Ends HIGH. |
| Legitimate doctor's office | Ends LOW. No alert SMS, no alert event, no report. |
| Real grandchild with the safe word | Ends LOW and the call state is verified. The safe word is never stored in any event. |

## Testing

```bash
npm test               # vitest run
npm run test:watch     # watch mode
npm run test:coverage  # with coverage
npx tsc --noEmit       # type check
```

Last run (2026-11-26): 46 test files, 661 tests passing plus 6 expected failures (documented known gaps in the scam fixtures, run with `it.fails`), 667 in total. Type check: 0 errors. `npm run build` succeeds.

The tests cover scoring (including property-based tests with fast-check), the 30 scam and legitimate call fixtures in `tests/fixtures/`, the voice webhooks, the safe word and callback flow, the time-waster limit, alerts and report text, privacy of logs, and the dashboard passcode.

## Project documents

- `.kiro/specs/`: seven specs (requirements, design, tasks).
- `.kiro/steering/`: steering docs.
- `KIRO_LOG.md`: how we used Kiro.
- `DEV-PHONE.md`: the browser phone.

## License

MIT. See `LICENSE`.
