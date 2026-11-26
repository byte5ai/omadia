-- One absolute-minute cursor per schedule, including minutes that started no run.
-- Seed at installation so pre-upgrade uptime gaps are outside the new policy.
ALTER TABLE conductor_schedules
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ NOT NULL
    DEFAULT (date_trunc('minute', now()) - interval '1 minute');

DELETE FROM conductor_schedules s
 USING conductor_workflows w
 WHERE s.workflow_id = w.id AND w.origin = 'manual' AND w.reaped_at IS NOT NULL;
