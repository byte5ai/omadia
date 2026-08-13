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
-- ORPHANED — KNOWINGLY RETAINED. The plugin-facing accessor was deleted, and
-- with it the host `createJob` that was the ONLY writer of `source='plugin'`.
-- That accessor never had a provider and never had a consumer, so no row ever
-- carried this value in production and no code path can produce it now. The
-- widened CHECK stays because the migrations here are forward-only, and
-- 'plugin' stays in the runtime source union so a hypothetical pre-existing
-- row still validates. Do NOT read this value as evidence of a live feature.
-- Rationale: dormant-capabilities.md §2 (epic #470).
--
-- Forward-only, idempotent: drop the auto-named inline CHECK from 0022 and
-- re-add it with 'plugin' included. Safe to re-run (DROP ... IF EXISTS).
ALTER TABLE dev_jobs DROP CONSTRAINT IF EXISTS dev_jobs_source_check;
ALTER TABLE dev_jobs ADD CONSTRAINT dev_jobs_source_check
  CHECK (source IN ('chat','admin','conductor','webhook','schedule','tracker','plugin'));
