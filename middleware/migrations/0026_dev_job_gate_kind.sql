-- Epic #470 W3 — distinguish gate kinds on `dev_job_gates`.
--
-- Two gate kinds now share the table, and they resume DIFFERENTLY on approval:
--   'review'      — the plan/clarify/review human gate (W2). Approval re-queues the
--                   job at `implement`; the runner re-runs.
--   'diff_policy' — the AUTHORITATIVE apply gate (W3). Approval must RE-APPLY the
--                   already-produced diff (the runner already exited), not re-run it.
-- Without a way to tell them apart, an approved diff-policy gate would wrongly
-- re-run the runner. Default 'review' so every pre-existing row keeps its W2
-- semantics. Forward-only, idempotent.
ALTER TABLE dev_job_gates
  ADD COLUMN IF NOT EXISTS gate_kind TEXT NOT NULL DEFAULT 'review'
    CHECK (gate_kind IN ('review','diff_policy'));
