-- Epic #470 W3 — diff-policy overrides, plugin repo grants, conductor-await link.
-- Renumbered 0023 → 0024: the W3 spec text was written as 0023, but W2 already
-- took 0023 (0022 = W0). Forward-only, idempotent (ADD COLUMN IF NOT EXISTS /
-- CREATE TABLE IF NOT EXISTS), safe to re-run.
--
-- No CHECK on growing enums, consistent with 0022/0023: every wave adds kinds
-- and a DB CHECK on a growing enum is a liability. Runtime validators in
-- src/devplatform own that enforcement.

-- --- operator diff-policy overrides on the repo ----------------------------
-- Shape: { maxFiles?, maxAddedLines?, extraProtectedGlobs?, unprotectedGlobs? }.
-- Merge in diffPolicyEngine is subtract-then-add over code defaults; overrides
-- can NEVER remove a `deny` rule (git-internals, credential-content).
ALTER TABLE dev_repos
  ADD COLUMN IF NOT EXISTS policy_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- --- link a parked job to its holding conductor await (W3 §5) ---------------
-- ORPHANED COLUMN — do NOT read this as evidence of a live feature.
-- It was added for the Conductor `dev.job` step, which was built but never wired:
-- the run executor was always constructed without the port, so the dispatch branch
-- was permanently false and NOTHING EVER WROTE THIS COLUMN. That step was deleted
-- in epic #470 C5 (see the dormant-capabilities spec, §1). The column stays only
-- because migrations are forward-only here and a DROP is the one irreversible act
-- in that change. It has no reader and no writer in `src/`, and it is always NULL.
-- If the step is ever rebuilt (as a new feature, in the plugin repo) it may reclaim
-- this column; otherwise a future migration squash may drop it.
ALTER TABLE dev_jobs
  ADD COLUMN IF NOT EXISTS conductor_await_id text;

-- --- operator grant: which plugin may drive dev jobs on which repo (W3 §2) --
-- The ctx.devJobs accessor resolves ONLY operator-granted repos; everything
-- else fails closed. Mirrors the MCP-server grant pattern.
CREATE TABLE IF NOT EXISTS dev_repo_plugin_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id     UUID NOT NULL REFERENCES dev_repos(id) ON DELETE CASCADE,
  plugin_id   TEXT NOT NULL,
  granted_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS dev_repo_plugin_grants_repo_idx
  ON dev_repo_plugin_grants (repo_id);
