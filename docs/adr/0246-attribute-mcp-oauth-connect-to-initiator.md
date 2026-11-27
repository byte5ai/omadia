# 0246 — Attribute an MCP OAuth connection to the signed-in initiator

## Status

Accepted

- **Date:** 2026-11-26
- **Related:** #1951, [ADR-0100](0100-admin-audit-trail-one-actor-rule.md),
  [ADR-0168](0168-mcp-oauth-token-lifecycle-invalidation-marks-and-revoke-on-disconnect.md),
  [ADR-0175](0175-mcp-oauth-callback-completes-only-for-the-starter.md)

## Context and Problem Statement

The OAuth callback consumes one-time state and validates the completing session
under ADR-0175. The delegation key can represent a shared identity, and the
desktop loopback exception allows a callback without the operator's cookie.
The audit needs to identify who initiated a successful flow in both cases.

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
authorization start into the one-time flow. The callback validates the completer
under ADR-0175. Write `mcp_server.oauth_connect` after a successful token
write, using the actor from the consumed flow.
The audit row carries the server id and authorization outcome. In-flight flows
created before migration 0115 can complete with an unattributed event.

## Consequences

- The initiator remains identifiable for shared delegations and the desktop loopback exception.
- The initiator's UUID and email follow the existing pending flow lifecycle.
