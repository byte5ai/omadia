-- ── Deleting an agent keeps a tombstone (#2088, spec 2042 §5.10) ───────────
-- An agent delete was a bare `DELETE FROM agents`, and nine tables reference
-- `agents` with ON DELETE CASCADE: identity, plugin and tool grants, working
-- modes, internal helpers, schedules, channel policies, channel bindings and
-- message subscriptions went with the row. A conversation bound to the agent
-- lost its binding and fell through to the default agent, which then answered
-- in the deleted agent's place.
--
-- A delete now marks the row. The row and everything that references it stay:
--
--   deleted_at    when it was deleted; NULL = a live agent
--   deleted_by    who deleted it (user id or e-mail, as the audit records it)
--   deleted_slug  the slug it had. The live `slug` is replaced by a
--                 placeholder (`deleted-<id prefix>`) so the name is free for
--                 a new agent; this column keeps the original for display.
--
-- Every reader of `agents` goes through the config store, which excludes
-- tombstones. The hard delete (with the cascade) is a separate, explicit
-- operator action on a tombstone.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_by   TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_slug TEXT;

COMMENT ON COLUMN agents.deleted_at IS
  '#2088 tombstone: set when the agent was deleted. The row and its children stay until an explicit purge. NULL = live.';

CREATE INDEX IF NOT EXISTS agents_deleted_at_idx ON agents (deleted_at) WHERE deleted_at IS NOT NULL;

-- A tombstone never comes back to life and is never the default agent: the
-- default agent answers unbound traffic, a deleted agent answers nothing.
CREATE OR REPLACE FUNCTION agents_guard_tombstone() RETURNS trigger AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'agent % was deleted and cannot be restored; create a new agent', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agents_tombstone_final';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM multi_orchestrator_settings WHERE fallback_agent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'agent % is the default agent and cannot be deleted', OLD.slug
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agents_default_not_deleted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_tombstone_guard ON agents;
CREATE TRIGGER agents_tombstone_guard
  BEFORE UPDATE OF deleted_at ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_guard_tombstone();

-- rollback:
--   DROP TRIGGER IF EXISTS agents_tombstone_guard ON agents;
--   DROP FUNCTION IF EXISTS agents_guard_tombstone();
--   DROP INDEX IF EXISTS agents_deleted_at_idx;
--   (tombstoned rows must be purged or restored by hand before the columns go)
--   ALTER TABLE agents DROP COLUMN IF EXISTS deleted_slug, DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at;
