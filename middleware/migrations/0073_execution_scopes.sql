-- ── Execution scopes, conversation reservations, kill switch (#2090, spec 2043 §0) ──
-- An archetype plugin runs its own scheduler. Every action of it (a model
-- turn, a post, a direct message, a check, a delivery) needs the kernel's
-- execution authorization, and an authorization is drawn from an execution
-- scope: a bounded permission of one agent for one process (a facilitation),
-- with a deadline, a budget and the targets it may address.
--
--   conversation_reservations  one running process per conversation. Native
--                              facilitations and agent discussions share it
--                              (spec 2043 §5.3). A released row stays: it
--                              records that the process held the conversation,
--                              which is what lets a closing scope still post
--                              there after the release.
--   execution_scopes           one row per scope. `kind` is one of the five of
--                              spec 2043 §0. A (plugin, process, kind, event)
--                              exists once, ever: an ended scope never
--                              re-opens. Counters are columns, so they survive
--                              a restart and two workers cannot both take the
--                              last unit.
--   execution_authorizations   one row per authorized action: the audit trail,
--                              and the handle a model turn settles its
--                              reserved model calls against.
--   execution_kill_switches    set by an operator for the instance, one agent
--                              or one process. A set switch refuses every
--                              authorization in its reach; it ends nothing.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS conversation_reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_type    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  holder_kind     TEXT NOT NULL,
  agent_id        UUID REFERENCES agents (id) ON DELETE CASCADE,
  plugin_id       TEXT,
  process_id      TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'home',
  reserved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ,
  release_reason  TEXT,
  CONSTRAINT conversation_reservations_holder_check
    CHECK (holder_kind IN ('archetype_process', 'agent_discussion')),
  CONSTRAINT conversation_reservations_role_check
    CHECK (role IN ('home', 'session'))
);

-- The reservation itself: at most one unreleased row per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_reservations_held_idx
  ON conversation_reservations (channel_type, conversation_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS conversation_reservations_process_idx
  ON conversation_reservations (plugin_id, process_id);
CREATE INDEX IF NOT EXISTS conversation_reservations_agent_idx
  ON conversation_reservations (agent_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS execution_scopes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  agent_slug         TEXT NOT NULL,
  plugin_id          TEXT NOT NULL,
  process_id         TEXT NOT NULL,
  kind               TEXT NOT NULL,
  event_id           TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL DEFAULT 'open',
  deadline           TIMESTAMPTZ NOT NULL,
  absolute_limit     TIMESTAMPTZ NOT NULL,
  deadline_wait      BOOLEAN NOT NULL DEFAULT false,
  budget_actions     INTEGER NOT NULL,
  budget_model_calls INTEGER NOT NULL,
  used_actions       INTEGER NOT NULL DEFAULT 0,
  used_model_calls   INTEGER NOT NULL DEFAULT 0,
  targets            JSONB NOT NULL DEFAULT '[]'::jsonb,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  end_reason         TEXT,
  CONSTRAINT execution_scopes_kind_check
    CHECK (kind IN ('configuring', 'active', 'closing', 'scheduling', 'follow_up')),
  CONSTRAINT execution_scopes_state_check CHECK (state IN ('open', 'ended')),
  CONSTRAINT execution_scopes_budget_check
    CHECK (budget_actions >= 0 AND budget_model_calls >= 0
           AND used_actions >= 0 AND used_model_calls >= 0
           AND used_actions <= budget_actions AND used_model_calls <= budget_model_calls),
  CONSTRAINT execution_scopes_limit_check CHECK (deadline <= absolute_limit)
);

-- Once, ever: an ended scope never re-opens.
CREATE UNIQUE INDEX IF NOT EXISTS execution_scopes_once_idx
  ON execution_scopes (plugin_id, process_id, kind, event_id);
CREATE INDEX IF NOT EXISTS execution_scopes_open_idx
  ON execution_scopes (agent_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS execution_scopes_deadline_idx
  ON execution_scopes (deadline) WHERE state = 'open';

CREATE TABLE IF NOT EXISTS execution_authorizations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id             UUID NOT NULL REFERENCES execution_scopes (id) ON DELETE CASCADE,
  action               TEXT NOT NULL,
  purpose              TEXT NOT NULL,
  phase                TEXT NOT NULL,
  target               JSONB,
  reserved_model_calls INTEGER NOT NULL DEFAULT 0,
  used_model_calls     INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS execution_authorizations_scope_idx
  ON execution_authorizations (scope_id, created_at);

CREATE TABLE IF NOT EXISTS execution_kill_switches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level      TEXT NOT NULL,
  agent_id   UUID REFERENCES agents (id) ON DELETE CASCADE,
  process_id TEXT,
  reason     TEXT NOT NULL DEFAULT '',
  set_by     TEXT NOT NULL,
  set_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at TIMESTAMPTZ,
  cleared_by TEXT,
  CONSTRAINT execution_kill_switches_level_check
    CHECK (level IN ('instance', 'agent', 'process')),
  CONSTRAINT execution_kill_switches_reach_check
    CHECK ((level = 'instance' AND agent_id IS NULL AND process_id IS NULL)
        OR (level = 'agent' AND agent_id IS NOT NULL AND process_id IS NULL)
        OR (level = 'process' AND agent_id IS NOT NULL AND process_id IS NOT NULL))
);
-- One set switch per reach.
CREATE UNIQUE INDEX IF NOT EXISTS execution_kill_switches_set_idx
  ON execution_kill_switches (level, COALESCE(agent_id::text, ''), COALESCE(process_id, ''))
  WHERE cleared_at IS NULL;

-- A discussion that is running while this migration is applied holds its
-- conversation through the Conductor's own row. Give it the shared
-- reservation, so a facilitation cannot start on top of it. The Conductor's
-- tables come from its own migrator and may not exist yet.
DO $$
BEGIN
  IF to_regclass('conductor_ephemeral_attachments') IS NOT NULL THEN
    INSERT INTO conversation_reservations (channel_type, conversation_id, holder_kind, process_id)
    SELECT a.channel_type, a.channel_key, 'agent_discussion', 'discussion:' || a.id::text
      FROM conductor_ephemeral_attachments a
     WHERE NOT EXISTS (
       SELECT 1 FROM conversation_reservations r
        WHERE r.channel_type = a.channel_type AND r.conversation_id = a.channel_key
          AND r.released_at IS NULL)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
