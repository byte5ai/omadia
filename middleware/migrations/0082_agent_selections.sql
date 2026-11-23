-- ── A user's agent selection per conversation (#2055, spec 2042 §5.3, §5.6) ─
-- In a channel without one identity per agent, a user chooses an agent
-- explicitly (for example `/agent Mira`). The management layer stores that
-- choice per user and conversation, so two people in one group can each keep
-- their own agent. It ranks after explicit addressing and before the
-- conversation's binding.
--
-- `principal` is the user principal `user:<id>`. A selection keeps pointing to
-- a deleted agent (tombstone: a delete is an UPDATE) and yields "<name> was
-- deleted" until the user chooses again. The hard purge of the tombstone
-- removes the selections with it (ON DELETE CASCADE): they are per user and
-- cheap to lose, and only that user could clear them otherwise.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS agent_selections (
  channel_type     TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  principal        TEXT NOT NULL CHECK (principal ~ '^user:.+'),
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  selected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_type, conversation_key, principal)
);

CREATE INDEX IF NOT EXISTS agent_selections_agent_idx ON agent_selections (agent_id);

COMMENT ON TABLE agent_selections IS
  '#2055 per-user agent selection in one conversation; ranks before the binding.';

DROP TRIGGER IF EXISTS agent_selections_notify ON agent_selections;
CREATE TRIGGER agent_selections_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_selections
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

-- rollback:
--   DROP TABLE agent_selections;
