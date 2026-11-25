# 0041 — Conductor webhooks: context opt-in, bounded retention, signed timestamps, rotation grace

## Status

Accepted

- **Date:** 2026-11-24
- **Deciders:** Maintainers, from issue #1707; PR #2033. Builds on #2021, which made
  the outbound event name follow the run's terminal status 1:1 (`run.cancelled`).

## Context and Problem Statement

Conductor webhooks have an outbound side (subscriptions deliver run events) and an inbound
side (endpoints receive signed requests that start or resume runs). Five gaps together decided
what leaves the server and what an operator can reconstruct afterwards:

- A delivery carried the run's whole `context`, every step result including free text a human
  typed into an approval, to the receiver and into `conductor_webhook_deliveries.payload`
  indefinitely.
- No retention on the delivery ledger.
- No `admin_audit` row for any webhook administration.
- Inbound requests carried a signature and a delivery id but no timestamp, so a captured
  request stayed valid forever.
- Rotating a secret rejected the sender's very next request, which stops secrets from being
  rotated at all. And with `CONDUCTOR_WEBHOOKS_ENABLED=false` every inbound request answered
  `200 {"outcome":"disabled"}`, so senders dropped their events as delivered.

What is the security model of the webhook surface?

## Decision Drivers

- Data leaves the server only when an operator chose it (ADR-0016, ADR-0019).
- Existing senders and receivers keep working through an upgrade, except where keeping them
  means keeping a leak.
- A rotation that answers a leak must still be immediate.

## Considered Options

- **A — Context opt-in per subscription, retention sweep, audited administration, timestamp
  inside the MAC (optional until enforced), rotation with a grace window, honest 503.**
- **B — Keep the full context and protect the receiver side only** (TLS, allow-listed URLs).
- **C — Require timestamps and drop the old secret at once**, breaking older senders.

## Decision Outcome

Chosen option: **A**.

- **Context is opt-in.** `conductor_webhook_subscriptions.include_context`, default `false`,
  also for existing rows. The payload is projected per subscription before the delivery row is
  written, so neither wire nor ledger holds it; `contextOmitted: true` takes its place. The
  inline hook and the reconciliation pass share one projection.
- **Bounded retention.** The payload is redacted to `{runId, status, redacted}` after 30 days
  (`runId` stays: the unique index per run depends on it); terminal rows are deleted after
  180 days, `pending` rows never. Both windows clamp to at least 2 days, outside the retry
  worker's 24 h reconciliation lookback.
- **Audit.** Nine administration actions write `admin_audit`; `before`/`after` carry url,
  event, enabled state and payload scope, never a secret or payload. No-ops are not audited;
  status routes answer `404` for an unknown id.
- **Replay window.** A sender may stamp `X-Webhook-Timestamp` and then signs
  `<timestamp>.<raw body>`, checked in both directions before any endpoint lookup. The bare-body
  scheme stays open until `CONDUCTOR_WEBHOOK_REQUIRE_TIMESTAMP=true`.
- **Rotation grace.** The old secret stays valid until `secret_previous_until`;
  `?immediate=true` deletes it at once. Rotation and cleanup serialise on a per-endpoint
  advisory lock in its own namespace, never blocking the delivery claim.
- **Visible kill switch.** A disabled inbound surface answers `503 webhook.inbound_disabled`;
  `GET …/webhooks/posture` reports it and the windows in force.

### Consequences

- 🟢 **Good:** Approval comments and step results no longer leave the server by default;
  stored payloads age out.
- 🟢 **Good:** Operators can reconstruct who changed a webhook; secrets can be rotated without
  an outage.
- 🔴 **Bad (breaking):** Subscriptions stop sending context until an operator opts in; a
  disabled inbound route answers 503 instead of 200; status routes 404 an unknown id.
- 🔴 **Bad:** Replay protection is off by default until every sender stamps; the inbound
  delivery-id ledger has no retention, because pruning it would reopen replay.
- ⚪ **Neutral:** Outbound deliveries still sign the body alone; a second scheme would break
  every receiver. Already stored context is cleared by the 30-day window, not backfilled.

## Pros and Cons of the Options

### A — Opt-in, retention, audit, optional timestamps, grace

- 🟢 Closes the leak on upgrade, keeps senders working.
- 🔴 Replay protection depends on an operator flag.

### B — Receiver-side protection only

- 🟢 No breaking change.
- 🔴 The ledger keeps the data; the receiver still gets it.

### C — Strict timestamps and hard rotation

- 🟢 Strongest guarantees immediately.
- 🔴 Breaks every sender that predates the header; hard rotation is why secrets were not
  rotated.

## More Information

- Migration: the Conductor webhook-hardening migration in #2033 (`include_context`,
  `secret_previous_until`, retention index).
- Related: #2021 (`conductor/webhookEvents.ts`, 1:1 status-to-event mapping),
  [ADR-0038](0038-conductor-routes-check-id-shape-400-then-404.md), ADR-0034.
