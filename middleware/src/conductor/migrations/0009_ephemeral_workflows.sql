-- #330 Workstream A — ephemeral / JIT workflows.
--
-- Agent-generated workflows are instances of curated facilitation patterns,
-- namespaced away from the user-authored library via `origin` plus a reserved
-- `eph-` slug prefix (the create/instantiate routes reject it). "Removal" on
-- terminal state / TTL expiry is logical: the reaper disables the workflow and
-- stamps `reaped_at` — the run history and its version graph (the audit trace)
-- are retained; conductor_runs.workflow_version_id carries no ON DELETE clause
-- (Postgres default NO ACTION — blocks the delete exactly like RESTRICT here),
-- so a physical DELETE only ever happens for rows no run references.

ALTER TABLE conductor_workflows ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE conductor_workflows DROP CONSTRAINT IF EXISTS conductor_workflows_origin_check;
ALTER TABLE conductor_workflows ADD CONSTRAINT conductor_workflows_origin_check
  CHECK (origin IN ('manual', 'ephemeral'));

ALTER TABLE conductor_workflows ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE conductor_workflows ADD COLUMN IF NOT EXISTS created_by_agent TEXT;
ALTER TABLE conductor_workflows ADD COLUMN IF NOT EXISTS reaped_at TIMESTAMPTZ;

-- An ephemeral workflow without a TTL could outlive its run forever — exactly
-- the clutter #330 forbids. Mandatory at the schema level, not just in code.
ALTER TABLE conductor_workflows DROP CONSTRAINT IF EXISTS conductor_workflows_ephemeral_ttl_check;
ALTER TABLE conductor_workflows ADD CONSTRAINT conductor_workflows_ephemeral_ttl_check
  CHECK (origin <> 'ephemeral' OR expires_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS conductor_workflows_ephemeral_reap_idx
  ON conductor_workflows (expires_at) WHERE origin = 'ephemeral' AND reaped_at IS NULL;
