---
inclusion: always
---
Tech stack (all free tiers)
Next.js 16 App Router + TypeScript, deployed on Vercel. API routes are the backend.
Twilio Programmable Voice with TwiML: <Gather input="speech"> for listening, <Say> for
speaking, <Dial> to connect calls, REST API for outbound calls, redirects and SMS.
Every Twilio webhook must validate the X-Twilio-Signature header.

Google Gemini via @google/genai, model gemini-2.5-flash, JSON output validated with zod.
Supabase Postgres + Realtime. Server code uses the service role key; the browser uses anon.
Tests: vitest + fast-check (property-based tests).
Conversation state lives in the database keyed by Twilio CallSid, never in memory
(serverless functions do not share memory).

Each webhook must reply to Twilio within 10 seconds: keep Gemini prompts short.

All external services go through lib/providers. Mocks exist for telephony and AI; production must use the real ones