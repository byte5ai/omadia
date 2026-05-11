-- 0001_routines.sql
-- Persisted user-created scheduled agent invocations ("Routinen"). The
-- in-memory JobScheduler owns timing + lifecycle; this table is the
-- restart-survivable source of truth that the RoutineRunner reads at
-- startup and writes whenever an agent / user creates, pauses, or
-- deletes a routine.
--
-- Access pattern:
--   - read at boot              → load every active row, register with JobScheduler
--   - read by (tenant, user_id) → list a user's routines via manage_routine tool
--   - write on create / pause / resume / delete
--   - write on each trigger run → update last_run_at + last_run_status
--
-- Notes:
--   - id is UUID so the agent can pass it back in subsequent tool calls
--     without us leaking BIGSERIAL counts.
--   - user_id is opaque (channel-side principal id, e.g. Teams aadObjectId).
--     No FK to a users table — the kernel does not own a user model.
--   - conversation_ref is the channel-native delivery handle. For Teams
--     this is the bot-framework ConversationReference JSON; other channels
--     use whatever shape their proactive-send API expects. Treated as
--     opaque by this layer; the channel adapter parses it.
--   - cron is a 5-field expression (minute hour dom month dow). Validated
--     by the JobScheduler's croner-backed validateSpec on register; this
--     table itself only enforces non-empty.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS routines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant            TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  cron              TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  channel           TEXT NOT NULL,
  conversation_ref  JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  timeout_ms        INTEGER NOT NULL DEFAULT 60000,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at       TIMESTAMPTZ NULL,
  last_run_status   TEXT NULL,
  last_run_error    TEXT NULL,
  CONSTRAINT routines_status_chk
    CHECK (status IN ('active', 'paused')),
  CONSTRAINT routines_last_run_status_chk
    CHECK (last_run_status IS NULL
           OR last_run_status IN ('ok', 'error', 'timeout')),
  CONSTRAINT routines_cron_nonempty_chk
    CHECK (length(trim(cron)) > 0),
  CONSTRAINT routines_name_nonempty_chk
    CHECK (length(trim(name)) > 0),
  CONSTRAINT routines_prompt_nonempty_chk
    CHECK (length(trim(prompt)) > 0),
  CONSTRAINT routines_timeout_positive_chk
    CHECK (timeout_ms > 0),
  CONSTRAINT routines_user_name_unique
    UNIQUE (tenant, user_id, name)
);

-- Primary read path: list a user's routines newest first.
CREATE INDEX IF NOT EXISTS idx_routines_user
  ON routines (tenant, user_id, status, updated_at DESC);

-- Boot-time scan: load every active routine across tenants. Partial index
-- keeps it small even when the paused archive grows.
CREATE INDEX IF NOT EXISTS idx_routines_active
  ON routines (status)
  WHERE status = 'active';
