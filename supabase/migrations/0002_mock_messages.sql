-- =============================================================================
-- Ghostline – mock_messages table for MockTelephony
-- Migration: 0002_mock_messages.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- mock_messages
-- Written by MockTelephony to simulate SMS sends and callback calls.
-- Used in dev/test mode when MOCK_TELEPHONY=true.
-- ---------------------------------------------------------------------------
CREATE TABLE mock_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  to_number   text        NOT NULL,
  body        text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('sms', 'callback_call')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mock_messages_created_at_idx ON mock_messages(created_at DESC);
CREATE INDEX mock_messages_kind_idx        ON mock_messages(kind);
