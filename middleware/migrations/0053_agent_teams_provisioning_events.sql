-- ── Agent factory: per-step provisioning progress log (epic #860, #915) ────
-- One row per thing that HAPPENED while the provisioning runner
-- (`src/services/teamsProvisioningJob.ts`) walked an agent through the chain.
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- Migration 0049 persists exactly five facts about a run — the five chain
-- states (`app_registered`, `bot_created`, `package_built`,
-- `catalog_uploaded`, `installed`). Everything an operator actually waits for
-- happens BETWEEN two of them: the Entra replication poll after the app
-- registration, up to five ARM retries with exponential backoff, the catalog
-- upload. The runner knows all of it — `runWithRetries` counts attempts,
-- `handleFailure` computes the next delay — and none of it survived the
-- process, so the operator UI polled every 3s and had nothing new to show for
-- minutes at a time. The panel looked dead while the run was healthy.
--
-- So the runner gets somewhere to write it down. The identity row keeps
-- answering "where is this agent now"; this table answers "what has this run
-- been doing", which is the question a waiting operator is actually asking.
--
-- APPEND-ONLY, NEVER AUTHORITATIVE
-- --------------------------------
-- Nothing reads this table to make a decision. Resume logic, idempotency and
-- the state machine all still run off `agent_teams_identities` — a lost or
-- half-written event must never change what the runner does next, which is
-- also why the runner swallows every write failure here (one choke point, see
-- `TeamsProvisioningJobRunner.emit`). This is a diary, not a ledger.
--
-- RETENTION — CLEARED AT THE START OF EACH RUN
-- --------------------------------------------
-- The log describes ONE run. An operator who clicks "provision again" is
-- asking about the run they just started, not about the archaeology of the
-- one that failed last Tuesday, and a timeline that silently concatenates two
-- runs would show a step both succeeding and failing with no way to tell
-- which attempt was which. So `clearForAgent` truncates the agent's events as
-- the run begins (`TeamsProvisioningJobRunner.beginEventLog`) and the table
-- holds at most one run per agent — a few dozen rows.
--
-- The insert ALSO enforces a hard per-agent cap
-- (`MAX_EVENTS_PER_AGENT` in `platform/teamsProvisioningEventStore.ts`). That
-- is not redundancy for its own sake: the clear is best-effort like every
-- other write from the runner, so a Postgres hiccup at run start would
-- otherwise let a long-lived agent accumulate forever with nothing to stop
-- it. Two cheap mechanisms, one guarantee — the table cannot grow without
-- bound even when the primary one does not run.
--
-- NO SECRETS, NO PII
-- ------------------
-- `detail` carries short machine-readable notes the runner composes itself
-- (`skipped`, `retry_in_ms=8000;max_attempts=5`, a classified failure code) —
-- never a client secret, a token, a bearer header or a URL with a query
-- string. Every emit site in the runner is written against that rule.
--
-- ON DELETE CASCADE mirrors 0051: an event about an identity that no longer
-- exists is unreachable, and deleting the identity is the documented way to
-- unprovision an agent.
--
-- Idempotent by construction: CREATE TABLE / CREATE INDEX IF NOT EXISTS, so
-- re-applying the file is a no-op (schema CI double-applies every file in
-- this series).
CREATE TABLE IF NOT EXISTS agent_teams_provisioning_events (
  id         BIGSERIAL   PRIMARY KEY,
  agent_id   TEXT        NOT NULL
    REFERENCES agent_teams_identities (agent_id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Which link of the chain. The chain steps carry the name of the STATE they
  -- produce (`app_registered` … `installed`), so the operator UI can lay the
  -- events straight onto the progress chain it already renders without a
  -- second vocabulary. Two steps have no state of their own: `run` (the whole
  -- run's lifecycle) and `config_sync` (the post-install `teams_bots` write,
  -- #910). Deliberately NOT constrained by a CHECK: a future step must be
  -- writable by a newer runner against an older schema, and an unknown step
  -- is dropped by the UI parser rather than rejected by the database.
  step       TEXT        NOT NULL,
  status     TEXT        NOT NULL
    CONSTRAINT agent_teams_provisioning_events_status_check CHECK (status IN (
      'started',
      'progress',
      'retrying',
      'succeeded',
      'failed'
    )),
  -- Retry counter of `runWithRetries`, 1-based. NULL on everything that is
  -- not a retry — a `started` event has no attempt number to report, and
  -- writing 1 there would make the UI announce "attempt 1 of 5" for a step
  -- that never failed.
  attempt    INTEGER,
  detail     TEXT
);

-- The only query shape there is: the newest N events of one agent
-- (`listRecent`). Descending on the primary key rather than on `at` because
-- two events of the same run can share a timestamp at millisecond resolution
-- and insertion order is the truth we want.
CREATE INDEX IF NOT EXISTS agent_teams_provisioning_events_agent_recent_idx
  ON agent_teams_provisioning_events (agent_id, id DESC);

-- rollback: DROP TABLE agent_teams_provisioning_events;
