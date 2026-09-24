-- #978 — `agents.privacy_profile` is reserved and NOT enforced.
--
-- The column has existed since 0001 (`CHECK (privacy_profile IN ('strict',
-- 'default'))`). It is written by the operator API, returned by
-- `GET /operator/agents`, shown in the UI and seeded as 'strict' for the
-- first-boot fallback agent — but no runtime path reads it: the orchestrator's
-- runtime config has no posture field and nothing branches on 'strict'.
--
-- The column, its CHECK and its values stay as they are (no API break). This
-- migration only records the status in the schema, so a reader of the table
-- does not mistake 'strict' for an active privacy control. Comment-only and
-- idempotent: COMMENT ON simply overwrites.

COMMENT ON COLUMN agents.privacy_profile IS
  'Reserved, not enforced (#978): persisted and reported, read by no runtime path. strict behaves like default; a change refreshes registry metadata and does not rebuild the agent.';

-- rollback:
--   COMMENT ON COLUMN agents.privacy_profile IS NULL;
