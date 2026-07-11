-- Epic #470 W4 — atomic backstop for the webhook active-job dedupe (concurrency fix #3).
--
-- The route's `SELECT 1 ... LIMIT 1` active-job pre-check is check-then-act: two
-- deliveries for the SAME issue (a label remove + re-add mints two distinct
-- X-GitHub-Delivery GUIDs) can both pass the pre-check and both create a job. This
-- partial UNIQUE index is the atomic guard the pre-check cannot be: the second
-- concurrent INSERT fails with 23505, which `createTriggerJob` catches and turns
-- into a `deduped_active_job` outcome. At most ONE non-terminal `source='webhook'`
-- job may exist per (repo_id, source_ref) at a time.
--
-- The terminal set MATCHES `TERMINAL_DEV_JOB_STATUSES` (types.ts) / `TERMINAL_SET_SQL`
-- (devJobStore.ts) / `hasActiveTriggerJob` (triggerJobService.ts) exactly — a job in
-- any terminal state frees the slot for the next label event.
--
-- NUMBERING: this is a NEW file (next free slot 0028), NOT an edit to the already-
-- shipped 0027. The migration runner (`_multi_orchestrator_migrations`) keys applied
-- migrations on FILENAME, so an index folded into 0027 would never run on a DB that
-- already applied 0027. Forward-only, idempotent (IF NOT EXISTS).

CREATE UNIQUE INDEX IF NOT EXISTS dev_jobs_webhook_one_active
  ON dev_jobs (repo_id, source_ref)
  WHERE source = 'webhook'
    AND status NOT IN ('done','failed','cancelled','stalled','budget_exceeded');
