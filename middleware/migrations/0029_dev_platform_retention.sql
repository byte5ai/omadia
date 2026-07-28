-- Epic #470 W5 — data lifecycle / retention (spec §7).
--
-- The daily retention job runs two DELETEs over dev_job_events:
--   1. low tier:  DELETE ... WHERE type IN ('heartbeat','log') AND ts < cutoff
--   2. outer bound: DELETE ... WHERE ts < cutoff
-- The only event index shipped in 0022 is (job_id, id); under it BOTH deletes
-- sequentially scan every event row. A composite (ts, type) index serves the
-- outer-bound delete directly (leading `ts` range) and lets the low-tier delete
-- range-scan `ts` and satisfy the `type` filter from the index (no heap fetch).
-- NOTE: the (job_id, type, ts) shape suggested in the W5 brief leads with job_id,
-- which the GLOBAL (cross-job) retention delete never filters on — so it would not
-- be usable for either predicate. (ts, type) is the correct leading order here.
CREATE INDEX IF NOT EXISTS dev_job_events_ts_type_idx
  ON dev_job_events (ts, type);

-- Terminal-job purge (scripts/dev-transcript.ts purge) deletes dev_jobs rows that
-- are terminal AND ended before the cutoff; cascade removes their events/artifacts.
-- Without an index that predicate sequentially scans dev_jobs. Partial index over
-- the terminal set, keyed by ended_at, makes the purge a range scan.
CREATE INDEX IF NOT EXISTS dev_jobs_terminal_ended_idx
  ON dev_jobs (ended_at)
  WHERE status IN ('done', 'failed', 'cancelled', 'stalled', 'budget_exceeded');
