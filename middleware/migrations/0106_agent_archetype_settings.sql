-- ── Per-agent settings of the agent's archetype (#2066, spec 2043 §7) ───────
-- An archetype plugin declares fields the operator sets per agent of its
-- archetype (`archetype.agent_settings` in its manifest; for the facilitator:
-- default methods and reminder policy). The kernel validates the values
-- against those fields, stores them here and hands them to the plugin with
-- the agent's profile. An empty object = every field unset: the plugin's own
-- instance settings apply.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS archetype_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_archetype_settings_object_check'
       AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_archetype_settings_object_check
      CHECK (jsonb_typeof(archetype_settings) = 'object');
  END IF;
END $$;

-- Down (manual):
--   ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_archetype_settings_object_check;
--   ALTER TABLE agents DROP COLUMN IF EXISTS archetype_settings;
