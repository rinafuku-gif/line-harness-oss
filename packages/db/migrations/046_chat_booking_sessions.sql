-- Migration 046: Chat-driven consultation booking flow (LINE AI chat parity)
--
-- Tracks per-friend progress through the in-chat "空き枠提示 → 日時選択 →
-- 氏名/メール収集 → 確定" flow that runs after an external chat backend
-- (see services/chatBackend.ts) responds with book=true. This is separate
-- from the pre-existing `bookings`/`calendar_bookings` tables, which power
-- this Harness's own menu/staff booking feature — the chat flow instead
-- confirms bookings against an external backend (POST /line/booking) and
-- only needs to remember "where in the conversation is this friend" here.
--
-- One row per friend (PRIMARY KEY friend_id) — a friend can only be in one
-- booking conversation at a time. Session rows are deleted on completion,
-- explicit reset ("最初から"), or treated as expired by the reading service
-- after a TTL (see services/chatBookingSession.ts) so an abandoned flow
-- never permanently traps a friend's messages.

CREATE TABLE IF NOT EXISTS chat_booking_sessions (
  friend_id       TEXT PRIMARY KEY REFERENCES friends (id) ON DELETE CASCADE,
  state           TEXT NOT NULL CHECK (state IN ('awaiting_slot_selection', 'awaiting_name', 'awaiting_email')),
  selected_start  TEXT,
  selected_end    TEXT,
  name            TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
