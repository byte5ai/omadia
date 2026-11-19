-- ── A third archetype can exist (#2088) ────────────────────────────────────
-- 0070 added `agents.archetype` next to `agents.kind` and keeps the two equal
-- on insert. `kind` still had the closed CHECK of 0067 (`standard`,
-- `facilitator`), so an agent of any archetype a plugin registers could not
-- be created: the sync copied the archetype into `kind` and the CHECK
-- refused it.
--
-- The vocabulary is the registry now. `agents.archetype` references
-- `agent_archetypes`, where an installed archetype plugin's archetype gets
-- its row, and `kind` follows it without a list of its own. `kind` stays
-- equal to `archetype` for every row (so the two known archetypes read
-- exactly as before on a machine of the previous release); a machine that old
-- reads any other value as `standard`, which is why an archetype plugin
-- states the kernel version it needs.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check;

COMMENT ON COLUMN agents.kind IS
  '#2060 the name of agents.archetype before migration 0070; kept equal to it (trigger agents_kind_archetype_sync) until it is dropped. Fixed at creation.';

-- rollback:
--   ALTER TABLE agents ADD CONSTRAINT agents_kind_check CHECK (kind IN ('standard', 'facilitator'));
--   (only possible while no agent has another archetype)
