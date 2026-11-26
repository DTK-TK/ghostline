---
inclusion: always
---
Structure
app/api/voice/* Twilio voice webhooks (incoming, turn, callback, status)
app/api/sms/* inbound SMS (optional)
app/api/simulate Simulate-a-call endpoint for judges
app/(dashboard) family dashboard pages
lib/twiml.ts TwiML builders lib/scoring/ rules + AI scoring
lib/db.ts Supabase client lib/alerts.ts SMS alerts
lib/report.ts fraud report lib/gemini.ts Gemini wrapper
tests/ vitest + fast-check, fixtures in tests/fixtures/*.json
One function per file where practical. No business logic inside route files.