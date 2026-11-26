# 0246 — Attribute an MCP OAuth connection to the signed-in initiator

## Status

Proposed

- **Date:** 2026-11-26
- **Related:** #1951, [ADR-0100](0100-admin-audit-trail-one-actor-rule.md),
  [ADR-0168](0168-mcp-oauth-token-lifecycle-invalidation-marks-and-revoke-on-disconnect.md)

## Context and Problem Statement

The OAuth callback is public and is authorized by its one-time state. The cookie
may be absent or belong to a different signed-in operator. The delegation key
can also represent a shared identity. Neither identifies who initiated the flow.

## Decision Drivers

- Use the same `users.id` as other admin actions.
- Record a successful connection after its token has been persisted.
- Work across restarts and replicas without adding a second flow store.

## Considered Options

- Attribute the connect event through the callback's session.
- Record initiation and leave the successful connection unattributed.
- Capture the signed-in initiator in the existing pending OAuth flow.

## Decision Outcome

Use the third option. Copy the actor from `auditActorFromRequest` at
authorization start into the one-time flow. Write `mcp_server.oauth_connect`
after the callback persists the token, using the actor from the consumed flow.
The audit row carries the server id and authorization outcome. In-flight flows
created before migration 0115 can complete with an unattributed event.

## Consequences

- The operator remains identifiable for shared delegations and cookie-less callbacks.
- The initiator's UUID and email follow the existing pending flow lifecycle.
