-- Epic #470 W4 — trigger surfaces (spec §3/§11).
--
-- NOTE ON NUMBERING: the W4/W5 spec table §11 names this `0024_dev_platform_triggers`,
-- but 0024/0025/0026 were already taken in this repo (dev_platform_w3, source_plugin,
-- gate_kind). The next free slot is 0027; the content is the spec's, only the number
-- differs. Forward-only, idempotent (IF NOT EXISTS everywhere).
--
-- Three concerns:
--   1. `dev_webhook_deliveries` — the append-only audit + dedupe + rate-limit ledger.
--      EVERY inbound GitHub delivery leaves exactly one row (outcome recorded), so a
--      silent drop is impossible and redeliveries dedupe on the GitHub delivery GUID.
--   2. `dev_repos` — the trigger configuration columns W4 reads (label, sender allowlist,
--      per-repo kill switch) plus the forward columns later W4/W5 units need, shipped now
--      so those units do not re-migrate.
--   3. `dev_jobs` — the per-job budget + estimated-usage columns W4 accounting writes.
--
-- `allowed_triggers` is NOT added here: it already exists (0022, default ARRAY['admin']),
-- so a webhook is off by default until an operator adds 'webhook' to a repo's list.

CREATE TABLE IF NOT EXISTS dev_webhook_deliveries (
  delivery_id   TEXT PRIMARY KEY,                         -- the X-GitHub-Delivery GUID; dedupe key
  event         TEXT,                                     -- X-GitHub-Event (e.g. 'issues')
  repo          TEXT,                                     -- repository.full_name
  issue_number  INTEGER,
  sender        TEXT,                                     -- sender.login — persisted on EVERY delivery
  outcome       TEXT NOT NULL DEFAULT 'received',         -- job_created|refused_sender|rate_limited|
                                                          -- deduped_active_job|refused_policy|disabled|
                                                          -- duplicate|dropped_event|dropped_repo|dropped_label
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rate-limit counts read only rows that actually produced a job, in a time window,
-- keyed per-repo and per-(repo, sender). Partial indexes match those queries exactly.
CREATE INDEX IF NOT EXISTS dev_webhook_deliveries_repo_idx
  ON dev_webhook_deliveries (repo, received_at) WHERE outcome = 'job_created';
CREATE INDEX IF NOT EXISTS dev_webhook_deliveries_sender_idx
  ON dev_webhook_deliveries (repo, sender, received_at) WHERE outcome = 'job_created';

ALTER TABLE dev_repos
  ADD COLUMN IF NOT EXISTS trigger_label          TEXT NOT NULL DEFAULT 'omadia-dev',
  ADD COLUMN IF NOT EXISTS webhook_enabled        BOOLEAN NOT NULL DEFAULT true,
  -- Empty array = webhook triggers OFF for the repo (the default). A sender.login must
  -- be listed here before a labeled-issue delivery can create a job (spec §3 finding S7).
  ADD COLUMN IF NOT EXISTS webhook_senders        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tracker_poll_interval_s INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS tracker_poll_cursor    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS budget_cost_usd        NUMERIC,
  ADD COLUMN IF NOT EXISTS budget_tokens          BIGINT,
  ADD COLUMN IF NOT EXISTS runner_guest           JSONB,
  ADD COLUMN IF NOT EXISTS docker_in_job          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS forge_public           BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE dev_jobs
  ADD COLUMN IF NOT EXISTS budget_cost_usd   NUMERIC,
  ADD COLUMN IF NOT EXISTS budget_tokens     BIGINT,
  ADD COLUMN IF NOT EXISTS usage_estimated   BOOLEAN NOT NULL DEFAULT false;
