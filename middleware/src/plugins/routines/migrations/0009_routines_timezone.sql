-- #1743 / ADR 0240 — a routine's cron pattern is evaluated in a named IANA
-- zone: the creator's zone when the channel knew it, else the instance's
-- PROACTIVE_TIMEZONE. NULL (rows from before this migration) keeps the old
-- meaning, UTC.

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS timezone TEXT NULL;

COMMENT ON COLUMN routines.timezone IS
  '#1743 — IANA zone the cron pattern is evaluated in; NULL = UTC (rows from before migration 0009).';
