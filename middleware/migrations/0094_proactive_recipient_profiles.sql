-- ── Proactive messages: recipient profiles and deliveries (#2082, #1035) ────
-- Spec 2042 §5.12: proactive messages respect the recipient's communication
-- profile, quiet hours and a rate limit per recipient.
--
--   proactive_recipient_profiles  per recipient (a conversation or a person,
--                                 `<channel>:<id>`): time zone, quiet hours,
--                                 messages per hour. Missing row or NULL field
--                                 = the instance default from the config.
--   proactive_deliveries          one row per proactive message sent, for the
--                                 rate limit. Rows older than a day are purged.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS proactive_recipient_profiles (
  recipient_key TEXT PRIMARY KEY,
  timezone      TEXT,
  quiet_from    TIME,
  quiet_to      TIME,
  max_per_hour  INTEGER,
  updated_by    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proactive_recipient_profiles_quiet_check
    CHECK ((quiet_from IS NULL) = (quiet_to IS NULL)),
  CONSTRAINT proactive_recipient_profiles_rate_check
    CHECK (max_per_hour IS NULL OR max_per_hour >= 0)
);

CREATE TABLE IF NOT EXISTS proactive_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  recipient_key TEXT NOT NULL,
  trigger_id    UUID,
  agent_slug    TEXT NOT NULL,
  delivered_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proactive_deliveries_recipient_idx
  ON proactive_deliveries (recipient_key, delivered_at);
