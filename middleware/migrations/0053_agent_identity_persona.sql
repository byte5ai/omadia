-- ── Agent identity: the full persona block (#914 follow-up) ────────────────
-- The identity of #914 (migration 0052) could hold a name, a face and a free
-- text. That is a nameplate, not a character. This adds the persona model the
-- platform already speaks everywhere else — 12 axes, a template, culture
-- calibration, boundaries and a sycophancy level — to the DEPLOYED agent,
-- where it belongs, instead of only to Agent-Builder drafts.
--
-- WHY JSONB AND NOT COLUMNS
-- -------------------------
-- `persona` and `quality` are the SAME shapes the builder spec carries
-- (`PersonaConfigSchema` / `QualityConfigSchema` in
-- `plugins/builder/agentSpec.ts`) and that `agent.md` frontmatter mirrors.
-- Storing them as the documents they already are keeps one schema for two
-- storage sites: the routes validate with those very Zod schemas, and a new
-- axis or preset lands without a migration. Twelve nullable INT columns would
-- have to be re-derived into that document on every read anyway.
--
-- `composed_prompt` IS A CACHE, AND SAYS SO
-- -----------------------------------------
-- The prompt sections are compiled by pure functions in the middleware
-- (`composePersonaSection`, `compileBoundariesSection`,
-- `compileSycophancyGuard`) — but the consumer is the orchestrator PACKAGE,
-- which cannot import middleware code. So the identity routes compile on
-- write and store the result here, and `ConfigStore` joins THIS column into
-- `AgentRow.instructions`.
--
-- `composed_family` records which model family the persona deltas were
-- computed against, because that is the one input that can change without an
-- identity write (an operator re-routes the agent to Opus). It makes the
-- staleness VISIBLE and re-computable instead of silent.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op on re-apply (schema CI
-- double-applies every file in this series).
ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS persona         JSONB,
  ADD COLUMN IF NOT EXISTS quality         JSONB,
  ADD COLUMN IF NOT EXISTS composed_prompt TEXT,
  ADD COLUMN IF NOT EXISTS composed_family TEXT;

COMMENT ON COLUMN agent_identities.persona IS
  'PersonaConfig (12 axes 0-100, template, custom_notes) — same shape as the builder spec''s persona block.';
COMMENT ON COLUMN agent_identities.quality IS
  'QualityConfig (sycophancy level + boundary presets/custom lines) — same shape as the builder spec''s quality block.';
COMMENT ON COLUMN agent_identities.composed_prompt IS
  'CACHE: instructions + <persona> + boundaries + sycophancy, compiled on write. ConfigStore joins this into AgentRow.instructions; NULL falls back to the raw instructions.';
COMMENT ON COLUMN agent_identities.composed_family IS
  'Model family the persona deltas in composed_prompt were computed against (sonnet | opus | haiku).';

-- rollback:
--   ALTER TABLE agent_identities
--     DROP COLUMN persona, DROP COLUMN quality,
--     DROP COLUMN composed_prompt, DROP COLUMN composed_family;
