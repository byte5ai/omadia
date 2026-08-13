-- Epic #470 W5 — exactly-once guarantee for the `events_truncated` marker.
--
-- Forge W5 retention audit (A3b): recordTruncationOnce allocated its seq as
-- MAX(seq)+1 in the provision-0 namespace and, unlike appendHostEvent, did NOT
-- retry on a seq collision. Racing the finalize `status` event (also provision-0)
-- for the same seq, its ON CONFLICT (job_id,provision,seq) DO NOTHING silently
-- inserted zero rows and the marker was lost — defeating the "the log never lies"
-- invariant the truncation exists to uphold.
--
-- This partial unique index makes the marker exactly-once by SEMANTIC identity
-- (one per job), independent of the seq it happens to land on. recordTruncationOnce
-- now retries the seq allocation (mirroring appendHostEvent) AND relies on this
-- index as the race-proof backstop: two concurrent inserts that both pass the
-- NOT EXISTS pre-check land on this index, the loser gets ON CONFLICT DO NOTHING.
-- Forward-only, idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS dev_job_events_truncated_once_idx
  ON dev_job_events (job_id)
  WHERE type = 'status' AND payload->>'state' = 'events_truncated';
