# Requirements – data-model

## Overview

Ghostline protects elderly people from phone scams. Every inbound call is
screened by an AI, risk-scored, and logged. Family members watch the
dashboard in real time and can intervene. This spec defines the persistent
data layer that the voice pipeline, the dashboard, and the reporting features
all share.

## Requirements

### R1 — Household registry

The system must store one record per protected household containing:

- A unique identifier.
- The family name displayed on the dashboard.
- The senior's phone number, used to look up the household on every incoming
  call.
- A bcrypt hash of the household's safe word (never plaintext).
- A flag enabling or disabling the time-waster feature.
- A creation timestamp.

### R2 — Trusted contacts (ring-through list)

Each household must maintain a list of trusted phone numbers that bypass the
AI screen and connect directly to the senior. Each contact record must store
the contact's name, phone number, and relationship to the senior.

### R3 — Family members (alerts and callbacks)

Each household must have a list of family members. Each member record must
capture:

- Name and phone number.
- `gets_alerts` — whether this person receives SMS/call alerts when a
  suspicious call is detected.
- `is_callback_target` — whether this person can accept a live transfer when
  the senior requests a family member.

### R4 — Call log

The system must persist one record per Twilio call leg with:

- The Twilio `CallSid` (unique, used as the primary lookup key during an
  active call).
- The caller's `from_number` and their `claimed_identity` (what they said
  when asked).
- A `state` field tracking progress through the call state machine:
  `initiated → screening → verified / scam_blocked / time_wasted →
  transferring → completed / failed`.
- An integer `risk_score` (0–100) and a `risk_level` label
  (`low | medium | high | critical`).
- An `outcome` label (`transferred | blocked | dropped | time_wasted |
  unknown`).
- `started_at` and `ended_at` timestamps.
- A free-text `summary` written by Gemini at end of call.

### R5 — Call event log

Every meaningful event within a call must be appended to an immutable event
log. The event types are:

| type | meaning |
|---|---|
| `transcript` | One speech-to-text segment |
| `red_flag` | A suspicious phrase or pattern detected |
| `safe_word_attempt` | The senior attempted the safe word |
| `callback_started` | A family-member callback transfer was initiated |
| `callback_result` | The callback call ended |
| `state_change` | The call state machine transitioned |
| `alert_sent` | An SMS or outbound alert was sent |

Each event carries a typed `payload` (JSONB). The payload schema per type is
defined in `lib/db.ts` as a Zod discriminated union.

### R6 — Fraud reports

When Gemini produces a final fraud report for a call, the system must persist
the full structured report as JSONB, linked to the call.

### R7 — Realtime subscriptions

The `calls` and `call_events` tables must publish row-level changes via
Supabase Realtime so the dashboard can update without polling. Both tables
must have `REPLICA IDENTITY FULL` and be added to the `supabase_realtime`
publication.

### R8 — Referential integrity and cascades

All foreign keys must cascade deletes. Removing a household removes all its
contacts, family members, calls, call events, and fraud reports.

### R9 — Safe word storage

Safe words must be stored as bcrypt hashes (cost ≥ 12) using
`pgcrypto.crypt()`. The seed file must demonstrate this pattern. Plaintext
safe words must never be persisted.

### R10 — Seed data

A seed file must create one demo household:

- Family name: **Sun**
- Safe word: **pumpkin** (bcrypt-hashed)
- Two family members whose names and phone numbers are read from Postgres
  `current_setting()` values set via env vars at seed time.
- One trusted contact read from env vars.
