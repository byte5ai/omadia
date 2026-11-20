-- ── Agent-owned triggers (#2082, spec 2042 §5.12, ADR-0020) ──────────────────
-- An agent acts unasked only through a trigger it (or a user, for a routine)
-- created: a hook on an event (`on_event`), a one-shot wakeup (`wake_at`) or a
-- short-lived timer (`wake_every`). Every trigger has a deadline, limits and a
-- budget that the harness enforces; nothing here is a heartbeat.
--
--   agent_triggers              one row per live trigger. An ended trigger is
--                               deleted (spec: "expired triggers are deleted,
--                               not paused"); its history stays in the audit.
--   agent_trigger_occurrences   one row per occurrence (a due time or an
--                               event). Claimed under a lease and fired at
--                               most once: (trigger_id, occurrence_key) is
--                               unique, and a lease that ran out is retried
--                               only for essential triggers.
--   agent_trigger_spend         monthly spend per agent and for the instance,
--                               reserved before a firing and settled with the
--                               actual usage after it.
--   agent_trigger_context_activity
--                               when something last happened in a context, so
--                               a timer's pre-check can tell "nothing new"
--                               without a model.
--   agent_trigger_audit         creation, firing, pause, resume and end.
--
-- The kill switch is `execution_kill_switches` (migration 0073): its instance
-- and agent levels refuse every trigger firing in their reach.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS agent_triggers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  agent_slug              TEXT NOT NULL,
  kind                    TEXT NOT NULL,
  -- Who asked for it: the agent itself, a person's routine, or the system
  -- (a bounded batch such as memory consolidation).
  origin                  TEXT NOT NULL DEFAULT 'agent',
  -- The human owner of a routine, `<tenant>\n<user id>`; NULL otherwise.
  owner_key               TEXT,
  purpose                 TEXT NOT NULL,
  context_kind            TEXT NOT NULL,
  context_id              TEXT NOT NULL,
  -- Where a proactive message goes by default: the conversation the trigger
  -- was created in. `labels` are the discretion labels of that context.
  delivery_channel        TEXT,
  delivery_ref            JSONB,
  target                  JSONB,
  labels                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_id                TEXT,
  event_filter            JSONB,
  fire_at                 TIMESTAMPTZ,
  interval_seconds        INTEGER,
  cron                    TEXT,
  timezone                TEXT,
  live_context            BOOLEAN NOT NULL DEFAULT false,
  actions                 JSONB NOT NULL,
  delivery_class          TEXT NOT NULL DEFAULT 'droppable',
  until                   TIMESTAMPTZ NOT NULL,
  max_runs                INTEGER,
  runs                    INTEGER NOT NULL DEFAULT 0,
  state                   TEXT NOT NULL DEFAULT 'active',
  pause_reason            TEXT,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  consecutive_ineffective INTEGER NOT NULL DEFAULT 0,
  budget_per_firing_usd   NUMERIC(12, 6) NOT NULL,
  budget_total_usd        NUMERIC(12, 6) NOT NULL,
  model_calls_per_firing  INTEGER NOT NULL,
  spent_usd               NUMERIC(12, 6) NOT NULL DEFAULT 0,
  reserved_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
  last_fired_at           TIMESTAMPTZ,
  last_outcome            TEXT,
  last_error              TEXT,
  last_fingerprint        TEXT,
  created_by              TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_triggers_kind_check CHECK (kind IN ('on_event', 'wake_at', 'wake_every')),
  CONSTRAINT agent_triggers_origin_check CHECK (origin IN ('agent', 'routine', 'system')),
  CONSTRAINT agent_triggers_state_check CHECK (state IN ('active', 'paused')),
  CONSTRAINT agent_triggers_delivery_class_check CHECK (delivery_class IN ('droppable', 'essential')),
  CONSTRAINT agent_triggers_context_check
    CHECK (context_kind IN ('conversation', 'meeting', 'facilitation', 'task', 'routine', 'schedule', 'memory')),
  CONSTRAINT agent_triggers_shape_check CHECK (
    (kind = 'on_event' AND event_id IS NOT NULL AND max_runs IS NOT NULL)
    OR (kind = 'wake_at' AND fire_at IS NOT NULL AND fire_at <= until)
    OR (kind = 'wake_every' AND max_runs IS NOT NULL
        AND ((interval_seconds IS NOT NULL AND interval_seconds > 0 AND cron IS NULL)
          OR (interval_seconds IS NULL AND cron IS NOT NULL)))),
  CONSTRAINT agent_triggers_runs_check CHECK (runs >= 0 AND (max_runs IS NULL OR (max_runs > 0 AND runs <= max_runs))),
  CONSTRAINT agent_triggers_budget_check CHECK (
    budget_per_firing_usd >= 0 AND budget_total_usd >= 0 AND model_calls_per_firing >= 0
    AND spent_usd >= 0 AND reserved_usd >= 0)
);

CREATE INDEX IF NOT EXISTS agent_triggers_agent_idx ON agent_triggers (agent_id);
CREATE INDEX IF NOT EXISTS agent_triggers_context_idx ON agent_triggers (context_kind, context_id);
CREATE INDEX IF NOT EXISTS agent_triggers_event_idx ON agent_triggers (event_id) WHERE kind = 'on_event';
CREATE INDEX IF NOT EXISTS agent_triggers_until_idx ON agent_triggers (until);
CREATE INDEX IF NOT EXISTS agent_triggers_owner_idx ON agent_triggers (owner_key) WHERE owner_key IS NOT NULL;
-- A routine has exactly one trigger (two machines scheduling it at once
-- cannot create a second one).
CREATE UNIQUE INDEX IF NOT EXISTS agent_triggers_routine_once_idx
  ON agent_triggers (context_id) WHERE context_kind = 'routine';
-- Likewise an Agent Builder schedule (`agent_schedules`, migration 0095),
-- and a batch job per agent (`<job>:<agent>`).
CREATE UNIQUE INDEX IF NOT EXISTS agent_triggers_schedule_once_idx
  ON agent_triggers (context_id) WHERE context_kind = 'schedule';
CREATE UNIQUE INDEX IF NOT EXISTS agent_triggers_memory_once_idx
  ON agent_triggers (context_id) WHERE context_kind = 'memory';

CREATE TABLE IF NOT EXISTS agent_trigger_occurrences (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id     UUID NOT NULL REFERENCES agent_triggers (id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  due_at         TIMESTAMPTZ NOT NULL,
  payload        JSONB,
  state          TEXT NOT NULL DEFAULT 'pending',
  lease_owner    TEXT,
  lease_until    TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0,
  outcome        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  CONSTRAINT agent_trigger_occurrences_state_check
    CHECK (state IN ('pending', 'leased', 'done', 'dropped'))
);

-- Once per occurrence: the same due time or event never gets a second row.
CREATE UNIQUE INDEX IF NOT EXISTS agent_trigger_occurrences_once_idx
  ON agent_trigger_occurrences (trigger_id, occurrence_key);
CREATE INDEX IF NOT EXISTS agent_trigger_occurrences_due_idx
  ON agent_trigger_occurrences (due_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS agent_trigger_occurrences_lease_idx
  ON agent_trigger_occurrences (lease_until) WHERE state = 'leased';

CREATE TABLE IF NOT EXISTS agent_trigger_spend (
  -- 'instance', or the agent's id.
  scope        TEXT NOT NULL,
  month        DATE NOT NULL,
  spent_usd    NUMERIC(14, 6) NOT NULL DEFAULT 0,
  reserved_usd NUMERIC(14, 6) NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, month),
  CONSTRAINT agent_trigger_spend_check CHECK (spent_usd >= 0 AND reserved_usd >= 0)
);

CREATE TABLE IF NOT EXISTS agent_trigger_context_activity (
  context_kind     TEXT NOT NULL,
  context_id       TEXT NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  PRIMARY KEY (context_kind, context_id)
);

CREATE TABLE IF NOT EXISTS agent_trigger_audit (
  id         BIGSERIAL PRIMARY KEY,
  trigger_id UUID NOT NULL,
  agent_id   UUID,
  agent_slug TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_usd   NUMERIC(12, 6),
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_trigger_audit_event_check
    CHECK (event IN ('created', 'fired', 'deferred', 'refused', 'paused', 'resumed', 'renewed', 'ended'))
);
CREATE INDEX IF NOT EXISTS agent_trigger_audit_trigger_idx ON agent_trigger_audit (trigger_id, at);
CREATE INDEX IF NOT EXISTS agent_trigger_audit_agent_idx ON agent_trigger_audit (agent_slug, at);
