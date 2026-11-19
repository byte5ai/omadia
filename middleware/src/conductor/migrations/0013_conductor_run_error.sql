-- #1699 — a failed run records WHY it failed.
--
-- Until now the only trace of a failure was a line in the container log: the
-- run row carried `status = 'failed'` and nothing else, the step row carried a
-- postcondition outcome and an `actor` blob, and the API handed both out
-- verbatim — so "Verlauf" could render a red badge and no reason (FR-030 /
-- US2-AS4 ask for the reason).
--
-- Every write of `status = 'failed'` in `runExecutor.ts` has its own cause
-- (step id not in the graph, a misconfigured timer step, a human step with no
-- reachable holder, an effect that threw, a step that blew its timeout, an
-- await that expired with no fallback, an engine `stuck` decision, a resume
-- with no current step, the MAX_STEPS budget running out). The cause is known
-- at every one of those sites; these columns are where it now lands.
--
-- WHAT GOES IN THEM
-- -----------------
-- `error_code`    — a value of `ConductorRunErrorCode` (`conductor/runError.ts`),
--                   which is the single vocabulary and includes the engine's own
--                   exported `StuckCode` values unchanged.
-- `error_message` — the human-readable cause, redacted (`redactSecrets` +
--                   `redactProviderInternals`) and hard-truncated. Never a stack
--                   trace.
-- `error_detail`  — the typed arguments of the code (e.g. the engine's
--                   `nodeIds`, the agent/action ref, the blown budget in ms).
--
-- NOT ONLY ON FAILURE, ON PURPOSE
-- --------------------------------
-- A step row also carries a code when the run RECOVERED from the condition —
-- a human step whose role had no holder and that took its in-graph fallback,
-- an await that timed out into its fallback. Those runs end `completed` and
-- the operator still needs to see that a human was skipped. A timer ticking is
-- NOT such a condition (it is the step doing its job) and writes no code, and
-- neither does an operator cancel: `cancelled` is an outcome, not a fault.
--
-- The two run-level columns are a denormalized copy of the terminal step's
-- code/message, written in the same transaction. They exist because the run
-- LIST (`GET /:slug/runs`) returns runs without their steps, and a list that
-- cannot say why a run is red is the reason this issue was filed.
--
-- NO CHECK CONSTRAINT ON `error_code`, ON PURPOSE
-- ------------------------------------------------
-- Same reasoning as `middleware/migrations/0060_agent_teams_error_code.sql`,
-- plus one specific to this table: the error columns are written on the
-- FAILURE path, inside the same transaction as the step row and the run's
-- terminal `status`. A code missing from a CHECK would fail that transaction
-- and lose the `status = 'failed'` write itself — turning a recorded failure
-- into a run stuck at 'running'. The closed TypeScript union is the
-- vocabulary; the read path (`runStore.ts`) validates against it and DROPS an
-- unknown value, so the reader prints "cause not recorded" where the code would
-- go. `error_message` is deliberately kept in that case — it was redacted and
-- truncated on the way in, and it is the only help left — but it renders as
-- supporting detail, never as the label.
--
-- NO BACKFILL
-- -----------
-- The cause was never captured, so there is nothing to backfill from. Rows
-- written before this migration keep `error_code IS NULL`, which every reader
-- must render as "cause not recorded" — never as an invented one. An older
-- middleware build running against a database already on 0013 writes the same
-- NULLs, and reads identically.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS), because schema CI
-- double-applies every file in this series.

ALTER TABLE conductor_run_steps ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE conductor_run_steps ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE conductor_run_steps ADD COLUMN IF NOT EXISTS error_detail JSONB;

ALTER TABLE conductor_runs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE conductor_runs ADD COLUMN IF NOT EXISTS error_message TEXT;

-- rollback: ALTER TABLE conductor_runs DROP COLUMN error_message;
-- rollback: ALTER TABLE conductor_runs DROP COLUMN error_code;
-- rollback: ALTER TABLE conductor_run_steps DROP COLUMN error_detail;
-- rollback: ALTER TABLE conductor_run_steps DROP COLUMN error_message;
-- rollback: ALTER TABLE conductor_run_steps DROP COLUMN error_code;
