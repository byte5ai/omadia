-- ── Agent identity: per-Agent answer size (`verbosity`) ─────────────────────
-- Adds `verbosity` to `agent_identities` — phase 2 of the answer-verbosity
-- feature (phase 1, byte5ai/omadia#1369, added the installation-wide
-- `answer_verbosity` setup field on the orchestrator plugin).
--
-- WHY
-- ---
-- One installation-wide level fits a single-Agent deployment, but an HR
-- assistant answering "how many days of leave do I have" and a controlling
-- Agent writing a month-end summary want different sizes. The level is an
-- identity trait — it says how THIS Agent talks — so it lives next to the
-- persona on `agent_identities`, not in the plugin config.
--
-- NULL = inherit the installation default (and with that unset, `standard`,
-- which emits no prompt block at all). So every existing row keeps exactly
-- the prompt it had before this migration.
--
-- CHECK CONSTRAINT, ON PURPOSE
-- ----------------------------
-- The vocabulary is the closed five-step scale from
-- `packages/harness-orchestrator/src/answerVerbosity.ts` and it drives which
-- prompt block is spliced. A hand-written row with a sixth value would be
-- parsed to `undefined` and silently fall back to the default, which is the
-- kind of "configured but inert" state the route's zod enum already rejects —
-- the CHECK keeps the DB from disagreeing with the route.

ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS verbosity TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_identities_verbosity_check'
       AND conrelid = 'agent_identities'::regclass
  ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_verbosity_check
      CHECK (verbosity IS NULL OR verbosity IN ('tldr', 'brief', 'standard', 'detailed', 'max'));
  END IF;
END $$;

-- rollback:
--   ALTER TABLE agent_identities DROP CONSTRAINT IF EXISTS agent_identities_verbosity_check;
--   ALTER TABLE agent_identities DROP COLUMN IF EXISTS verbosity;
