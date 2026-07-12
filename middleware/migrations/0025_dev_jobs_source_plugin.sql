-- Epic #470 W3 — allow 'plugin' as a dev_jobs.source (ctx.devJobs.create).
--
-- The 0022 CHECK enumerated chat/admin/conductor/webhook/schedule/tracker.
-- Plugin-initiated jobs (epic #470 W3 §2) need their own honest provenance so
-- the audit trail distinguishes them, and so cancel-creator enforcement can
-- pair a `source='plugin'` job with its `created_by='plugin:<pluginId>'`
-- marker. Runtime validation of the growing enum lives in
-- src/devplatform/types.ts (DEV_JOB_SOURCES) — the DB CHECK only guards the
-- known set.
--
-- Forward-only, idempotent: drop the auto-named inline CHECK from 0022 and
-- re-add it with 'plugin' included. Safe to re-run (DROP ... IF EXISTS).
ALTER TABLE dev_jobs DROP CONSTRAINT IF EXISTS dev_jobs_source_check;
ALTER TABLE dev_jobs ADD CONSTRAINT dev_jobs_source_check
  CHECK (source IN ('chat','admin','conductor','webhook','schedule','tracker','plugin'));
