-- #1705 — a cancelled run is delivered as `run.cancelled`.
--
-- No schema change to the webhook tables: `conductor_webhook_subscriptions.event`
-- is free text (0007_webhooks.sql) and the vocabulary now lives in
-- `conductor/webhookEvents.ts`, enforced at the API edge (`webhookRoutes.ts` refuses
-- a subscription to an event that never fires). Rows that an older build wrote keep
-- working untouched, and existing `run.cancelled` rows — accepted with a 201 and
-- silent until now — simply start matching.
--
-- WHAT THIS FILE IS FOR
-- ---------------------
-- The reconciliation pass (`listMissingRunDeliveries`) now also considers runs that
-- ended 'cancelled'. Its read path over `conductor_runs` is the partial index
-- 0007 created, and that index's predicate stops at 'completed'/'failed' — so a
-- cancelled run would be reconciled through a sequential scan of every run row.
-- This adds the matching partial index for the third status.
--
-- A SECOND, NARROWER INDEX RATHER THAN REPLACING THE FIRST, ON PURPOSE
-- --------------------------------------------------------------------
-- The reconciliation JOIN is per-status (`s.event = ('run.' || r.status)`), so the
-- planner picks whichever partial index covers the status it is scanning for; one
-- index per status is as usable as one index over all three, and leaves
-- `conductor_runs_terminal_ended_idx` — the hot 'completed'/'failed' path — in place
-- instead of dropping and rebuilding it on an existing deployment's largest table.
--
-- Idempotent (CREATE INDEX IF NOT EXISTS), because schema CI double-applies every
-- file in this series.

CREATE INDEX IF NOT EXISTS conductor_runs_cancelled_ended_idx
  ON conductor_runs(ended_at)
  WHERE status = 'cancelled' AND is_dry_run = false;

-- rollback: DROP INDEX IF EXISTS conductor_runs_cancelled_ended_idx;
