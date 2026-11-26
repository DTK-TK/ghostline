# Manual check: Simulate a call, end to end

Task 24 of `.kiro/specs/dashboard-and-simulator`. Needs a human and a browser.
Record a screen capture of the whole run and attach it to the PR.

## Setup

In `.env.local`:

```
MOCK_TELEPHONY=true
ENABLE_SIMULATOR=true
ENABLE_DEV_TOOLS=true
AI_PROVIDER=mock          # or gemini
TIME_WASTER_SECONDS=20
SIMULATOR_SAFE_WORD=<any word>
DASHBOARD_PASSCODE=<passcode>
```

The database needs the seeded demo household (`is_demo = true`) with at least two
family members that have `gets_alerts = true`. Clear old rows from `mock_messages`
so the counts below are easy to read. Run `npm run dev`, then sign in with the passcode.

Wait 30 s between runs (rate limit).

## A. Grandparent scam

1. Open `/live` in tab 1 and `/dev/phone` in tab 2 (Mock Inbox panel visible).
2. In tab 1 click **Simulate a call**, choose **grandparent**, start.

| # | Check | Expected |
|---|-------|----------|
| 1 | Lines appear | One caller line about every 1.5 s, each followed by Ghostline's reply |
| 2 | Badge | **SIMULATED** badge visible on `/live` for the whole call |
| 3 | Transcript | Scrolls to the newest line; "Jump to latest" shows if you scroll up |
| 4 | Red-flag chips | Chips appear with the caller's quoted words |
| 5 | Risk meter | Climbs and reaches **HIGH**, with the label (not colour only) |
| 6 | Safe word status | Changes from not asked to asked, then passed or failed |
| 7 | Callback status | Updates (calling, then denied/confirmed/no answer) when the scenario has a callback answer |
| 8 | Time-wasted timer | Runs while the call is in time-waster mode (20 s) and stops at the end |
| 9 | End | Call state shows ended; polling stops; "Last updated" stops changing |
| 10 | Mock Inbox (`/dev/phone`, within about 3 s) | For **each** family member: exactly **one** message starting `SIMULATED: GHOSTLINE HIGH`, plus the checklist SMS (`Reminder for ...`). Numbers show only the last four digits |
| 11 | Duplicates | Reload and wait: the counts do not grow |
| 12 | `/calls` | The call is the top row, with the SIMULATED badge and a **Report** link |
| 13 | Report | The link opens a report headed as simulated |

## B. Legitimate caller (doctor)

Repeat with the **doctor** scenario (Legitimate doctor's office; the simulator has no scenario named `legitimate_caller`).

| # | Check | Expected |
|---|-------|----------|
| 1 | Badge and lines | As in A.1 to A.3 |
| 2 | Risk meter | Ends **LOW**, no red-flag chips |
| 3 | Mock Inbox | No new messages |
| 4 | `/calls` | The row is there with the SIMULATED badge and **no** Report link |

## Known gaps when this was written

- Scam scenarios currently end **LOW**, not HIGH: `engine()` verifies the call
  after a LOW first line (conversation-and-scoring). Items A.5, A.10, A.12 and A.13
  will fail until that is fixed. Note the observed result in the PR.
- `finalizeCall()` passes `paymentMethod: null` to `sendAlerts()`, so the
  checklist SMS (A.10) is never sent, even for HIGH calls.

## Automated approximation

`npx vitest run tests/simulate-e2e.test.ts` covers the server side of both
scenarios (alerts, once per member, SIMULATED prefix, report, LOW with nothing sent).
It does not cover pacing, badges, meter, timer or the Mock Inbox panel.
