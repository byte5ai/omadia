-- Repair CHECK constraints that an unscoped existence probe silently skipped
-- (byte5ai/omadia#952).
--
-- 0050 and 0052 decided whether to add their CHECK constraints by asking
-- `pg_constraint` for the constraint NAME alone:
--
--     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '…')
--
-- Constraint names are unique per table, not per database. Any other schema
-- carrying a constraint of that name — a parallel test schema, a restored
-- snapshot, a second tenant — satisfies the probe. The migration then skips
-- creating the constraint AND REPORTS SUCCESS, leaving the column with no
-- validation at all while every log line says the schema is up to date.
--
-- The probes themselves are fixed in 0050 and 0052, which covers databases
-- created from now on. It does nothing for a database that already ran the
-- broken version: a migration that has been applied is never applied again.
-- Hence this one, which re-checks each constraint the correct way — scoped by
-- `conrelid` — and adds whatever is genuinely missing.
--
-- On a healthy database (including this project's production, verified before
-- writing this) all three already exist and every block below is a no-op.
--
-- DELIBERATELY NOT `NOT VALID`. If a row violates one of these, the ADD fails
-- and this migration stops — which is the honest outcome, because the same
-- data would have failed on a fresh install too. Adding the constraint as
-- unvalidated would hide bad rows behind a constraint that looks enforced,
-- and the point of this file is to stop exactly that kind of quiet lie.

DO $$
BEGIN
  -- 0050: agents.context_memory
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agents' AND relkind = 'r')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'agents_context_memory_check'
          AND conrelid = 'agents'::regclass
     ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_context_memory_check
      CHECK (context_memory IN ('off', 'enforce', 'enforce-strict'));
  END IF;

  -- 0052: agent_identities.accent_color
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agent_identities' AND relkind = 'r')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_identities_accent_color_check'
          AND conrelid = 'agent_identities'::regclass
     ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_accent_color_check
      CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;

  -- 0052: agent_identities.revision
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agent_identities' AND relkind = 'r')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_identities_revision_check'
          AND conrelid = 'agent_identities'::regclass
     ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_revision_check
      CHECK (revision >= 1);
  END IF;
END
$$;
