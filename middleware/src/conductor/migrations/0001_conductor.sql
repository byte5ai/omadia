-- Omadia Conductor — initial schema (Spec 005).
-- Enums are TEXT + CHECK (extend without ALTER TYPE), per data-model.md / spec 001.
-- Forward-only, idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER.

-- ---------------------------------------------------------------------------
-- Workflow header + immutable versions + mutable draft
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conductor_workflows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'disabled'
                      CHECK (status IN ('enabled', 'disabled')),
  active_version_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conductor_workflow_versions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES conductor_workflows(id) ON DELETE CASCADE,
  version      INT  NOT NULL,
  graph        JSONB NOT NULL,
  published_by UUID,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS conductor_workflow_drafts (
  workflow_id  UUID PRIMARY KEY REFERENCES conductor_workflows(id) ON DELETE CASCADE,
  graph        JSONB NOT NULL DEFAULT '{}',
  base_version INT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Runs + per-step durable record (resume checkpoint + audit trace)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conductor_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_version_id UUID NOT NULL REFERENCES conductor_workflow_versions(id),
  status              TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'waiting', 'completed', 'failed')),
  current_step_id     TEXT,
  context             JSONB NOT NULL DEFAULT '{}',
  trigger_kind        TEXT NOT NULL,
  trigger_source      JSONB,
  is_dry_run          BOOLEAN NOT NULL DEFAULT false,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS conductor_runs_waiting_idx
  ON conductor_runs(status) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS conductor_run_steps (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE,
  step_id               TEXT NOT NULL,
  seq                   INT  NOT NULL,
  actor                 JSONB,
  postcondition_outcome TEXT,
  transition_taken      TEXT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at              TIMESTAMPTZ,
  UNIQUE (run_id, seq)
);

-- ---------------------------------------------------------------------------
-- Durable awaits (+ DB-claim columns and unreachable flag — resolved decisions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conductor_awaits (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 UUID NOT NULL REFERENCES conductor_runs(id) ON DELETE CASCADE,
  step_id                TEXT NOT NULL,
  principal_kind         TEXT NOT NULL CHECK (principal_kind IN ('user', 'role')),
  principal_ref          TEXT NOT NULL,
  channel_type           TEXT NOT NULL,
  message                TEXT NOT NULL,
  quorum                 TEXT NOT NULL DEFAULT 'any' CHECK (quorum IN ('any', 'all')),
  reminder_interval_ms   BIGINT,
  deadline_at            TIMESTAMPTZ,
  fallback_transition_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'waiting'
                           CHECK (status IN ('waiting', 'resolved', 'timed_out', 'cancelled')),
  unreachable            BOOLEAN NOT NULL DEFAULT false,
  last_reminder_at       TIMESTAMPTZ,
  claimed_by             UUID,
  claimed_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS conductor_awaits_due_idx
  ON conductor_awaits(status, deadline_at, last_reminder_at) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS conductor_await_responses (
  await_id     UUID NOT NULL REFERENCES conductor_awaits(id) ON DELETE CASCADE,
  responder_id UUID NOT NULL,
  response     JSONB NOT NULL,
  responded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (await_id, responder_id)
);

-- ---------------------------------------------------------------------------
-- Roles + assignments (the baton). Read by the default RoleResolver.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conductor_roles (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  scope       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conductor_role_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key    TEXT NOT NULL REFERENCES conductor_roles(key) ON DELETE CASCADE,
  holder_id   UUID NOT NULL,
  provenance  TEXT NOT NULL DEFAULT 'manual',
  delegate_id UUID,
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conductor_role_assignments_role_idx
  ON conductor_role_assignments(role_key);

-- ---------------------------------------------------------------------------
-- User -> channel conversation-reference mapping (resolved decision #1):
-- how to proactively reach a user:<id> / role-resolved holder.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conductor_channel_bindings (
  user_id          UUID NOT NULL,
  channel_type     TEXT NOT NULL,
  conversation_ref JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_type)
);

-- ---------------------------------------------------------------------------
-- Cron schedules (resolved decision #2): sibling of agent_schedules, polled
-- by the same ScheduleWorker tick.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conductor_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES conductor_workflows(id) ON DELETE CASCADE,
  cron        TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  status      TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  claimed_by  UUID,
  claimed_at  TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conductor_schedules_role_idx
  ON conductor_schedules(workflow_id);

-- ---------------------------------------------------------------------------
-- Change-notification triggers (run resume + baton moves)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION conductor_notify_await_resolved() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('resolved', 'timed_out') AND OLD.status = 'waiting' THEN
    PERFORM pg_notify('conductor_await_resolved', NEW.run_id::text);
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conductor_await_resolved_trg ON conductor_awaits;
CREATE TRIGGER conductor_await_resolved_trg
  AFTER UPDATE ON conductor_awaits
  FOR EACH ROW EXECUTE FUNCTION conductor_notify_await_resolved();

CREATE OR REPLACE FUNCTION conductor_notify_role_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('conductor_role_changed', COALESCE(NEW.role_key, OLD.role_key));
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conductor_role_changed_trg ON conductor_role_assignments;
CREATE TRIGGER conductor_role_changed_trg
  AFTER INSERT OR UPDATE OR DELETE ON conductor_role_assignments
  FOR EACH ROW EXECUTE FUNCTION conductor_notify_role_changed();
