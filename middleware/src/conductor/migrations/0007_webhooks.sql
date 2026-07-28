-- Omadia Conductor — generic webhook support (issue #437): inbound endpoints that
-- start subscribed workflow runs, outbound subscriptions that deliver run-lifecycle
-- events to an external URL, and an outbound delivery ledger for retry + audit.
--
-- Metadata only — HMAC secrets never land in these tables. They live in the secret
-- vault under the `core:conductor` namespace (webhookEndpointStore.ts /
-- webhookSubscriptionStore.ts), the same split `DevGithubAppStore` uses for GitHub
-- App credentials (spec acceptance criterion: "secrets live in the vault, never in
-- graph JSON or API responses").

-- Inbound endpoints — POST /api/hooks/:endpointId (unauthenticated mount, HMAC
-- verified) maps to one of these rows and, on a verified delivery, emits `event_id`
-- through the existing ConductorEventRouter — any workflow with a matching
-- `event`/`webhook` trigger starts a run (US4 wiring, reused rather than duplicated).
CREATE TABLE IF NOT EXISTS conductor_webhook_endpoints (
  endpoint_id  TEXT PRIMARY KEY,      -- opaque public token used in the URL path
  event_id     TEXT NOT NULL,         -- Conductor event id emitted on a verified delivery
  description  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbound delivery ledger — one row per inbound call whose signature verified.
-- Keyed on (endpoint_id, delivery_id) — the caller-supplied delivery id
-- (`X-Webhook-Delivery-Id`) is only unique WITHIN one sender's own id space, so a
-- global PRIMARY KEY on delivery_id alone would let endpoint B's delivery '1' be
-- misread as a dupe of endpoint A's delivery '1' and silently swallow B's run.
-- Scoping the key per-endpoint fixes that while keeping the same dedupe semantics: a
-- redelivery of the SAME endpoint's id is still a no-op; a caller that never sends
-- the header still gets a server-generated id recorded here (no dedupe, but no
-- silent drop either — mirrors the terminal-outcome ledger `dev_webhook_deliveries`
-- established in Epic #470 W4).
CREATE TABLE IF NOT EXISTS conductor_webhook_inbound_deliveries (
  delivery_id  TEXT NOT NULL,
  endpoint_id  TEXT NOT NULL,
  outcome      TEXT NOT NULL DEFAULT 'received',
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS conductor_webhook_inbound_deliveries_endpoint_idx
  ON conductor_webhook_inbound_deliveries(endpoint_id, received_at DESC);

-- Outbound subscriptions — an operator-configured external URL that receives an
-- HMAC-signed delivery whenever the named internal event fires. `event` is
-- 'run.completed' / 'run.failed' (the run-lifecycle events this issue wires) but is
-- a free-text column so a future emit id can subscribe the same way.
CREATE TABLE IF NOT EXISTS conductor_webhook_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url          TEXT NOT NULL,
  event        TEXT NOT NULL,
  description  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conductor_webhook_subscriptions_event_idx
  ON conductor_webhook_subscriptions(event) WHERE enabled;

-- Outbound delivery log — one row per delivery, retried with backoff until
-- `max_attempts` (enforced in code) is exhausted. `next_attempt_at` is the retry
-- worker's poll key; the row is the durable audit trail an admin surface reads.
CREATE TABLE IF NOT EXISTS conductor_webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID NOT NULL REFERENCES conductor_webhook_subscriptions(id) ON DELETE CASCADE,
  event            TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed | exhausted
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conductor_webhook_deliveries_due_idx
  ON conductor_webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS conductor_webhook_deliveries_subscription_idx
  ON conductor_webhook_deliveries(subscription_id, created_at DESC);

-- Reconciliation support: `notifyRunEnded` (runExecutor.ts) fires the outbound
-- dispatcher fire-and-forget AFTER a run's terminal status is already committed to
-- `conductor_runs` — a process kill in that window commits the run 'completed'/
-- 'failed' but never creates its `conductor_webhook_deliveries` row(s), losing the
-- webhook permanently (the resume worker only re-drives runs still 'running'). The
-- webhook retry worker also runs a periodic reconciliation pass (see
-- `webhookSubscriptionStore.ts#listMissingRunDeliveries`) that finds terminal,
-- non-dry-run runs with no matching delivery row and creates the missing one(s).
-- This partial index is that pass's read path — `conductor_runs` predates this
-- migration (0001_conductor.sql) and had no index over ended_at.
CREATE INDEX IF NOT EXISTS conductor_runs_terminal_ended_idx
  ON conductor_runs(ended_at)
  WHERE status IN ('completed', 'failed') AND is_dry_run = false;
