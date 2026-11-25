-- Issue #1707 — webhook hardening: what leaves the server, how long it stays, and
-- what an operator can reconstruct afterwards.
--
-- 1. `include_context` — the run-lifecycle delivery payload used to carry the run's
--    whole `context`, i.e. every step result, including free-text human responses
--    ("P09 Testkommentar" in the report). That text left the server to an external
--    receiver and was stored here indefinitely. Context is now OPT-IN per
--    subscription, and the column DEFAULTS TO FALSE for existing rows too: a
--    subscription that was silently receiving step results stops receiving them
--    until an operator re-enables it deliberately. Breaking for such a receiver by
--    design — the alternative is keeping the leak for every install that upgrades.
--    The projection happens before the payload is written (webhookPayload.ts), so an
--    opted-out subscription's context never reaches `conductor_webhook_deliveries`
--    either, not just never reaches the wire.
ALTER TABLE conductor_webhook_subscriptions
  ADD COLUMN IF NOT EXISTS include_context BOOLEAN NOT NULL DEFAULT false;

-- 2. `secret_previous_until` — rotation grace. `rotateSecret` used to take effect
--    instantly: the sender's next request with the old secret answered 401 with no
--    overlap window, so every rotation was a guaranteed outage until the sender had
--    been reconfigured. The superseded secret now stays in the vault under its own
--    key and stays VALID until this deadline (rotation stamps
--    `now() + CONDUCTOR_WEBHOOK_SECRET_GRACE_SECONDS`).
--
--    The DEADLINE, not the rotation instant, is the stored value on purpose: the
--    verification path can decide whether to even look for a previous secret from
--    this one column, and a lapsed grace is cleared back to NULL (plus the vault key
--    deleted) exactly once instead of being re-evaluated per request.
--    NULL = no previous secret is valid (never rotated, or the grace has lapsed).
ALTER TABLE conductor_webhook_endpoints
  ADD COLUMN IF NOT EXISTS secret_previous_until TIMESTAMPTZ;

-- 3. Retention sweep read path. `conductor_webhook_deliveries.payload` was kept
--    forever; two bounded windows now apply (webhookRetention.ts): the payload is
--    REDACTED down to `{runId, status, redacted}` after the payload window, and the
--    row itself is deleted after the longer delivery window. Both sweeps scan by
--    `created_at` across all subscriptions — the existing
--    `conductor_webhook_deliveries_subscription_idx` leads with `subscription_id`
--    and cannot serve that.
--
--    The redaction deliberately KEEPS `runId` in the payload: `run_id` is a
--    generated column over `payload->>'runId'`, and the partial unique index
--    `(subscription_id, run_id)` is what makes "at most one delivery per run per
--    subscription" true. Redacting `runId` away would drop the row out of that
--    index and let the reconciliation pass create a second delivery for a run it
--    already delivered.
CREATE INDEX IF NOT EXISTS conductor_webhook_deliveries_created_idx
  ON conductor_webhook_deliveries(created_at);
