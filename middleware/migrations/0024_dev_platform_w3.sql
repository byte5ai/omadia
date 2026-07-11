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
-- Nullable: only Conductor-driven jobs park on an await. One-await invariant is
-- enforced in conductorBridge, not by a DB constraint here.
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
