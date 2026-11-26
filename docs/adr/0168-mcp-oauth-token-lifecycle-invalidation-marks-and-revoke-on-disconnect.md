# 0168 — MCP OAuth token lifecycle: invalidation marks and revoke-on-disconnect

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers; implemented in #2243 (issues #1923, #1925)
- **Supersedes:** —

## Context and Problem Statement

omadia stores one OAuth token row per (MCP server, user) in `mcp_oauth_tokens`, with the
access and refresh token values in the vault (ADR-0112). Until now the row was the
authorization: while it existed, `auth-status` said "connected", even after the
authorization server refused the refresh or the MCP server answered 401 to the token
(#1923). "Disconnect" deleted the row and left the grant live at the provider and the
values in the vault (#1925). Deleting a server cascaded the rows away the same way. What
does a stored row mean, and what does omadia owe the provider when it stops holding a
token?

## Decision Drivers

- The status display must not call an authorization valid that is known to be dead.
- A false "dead" is cheaper than a false "connected", but a working token must not be marked
  by a failure that was about something else.
- Disconnect is a user's request that omadia stop holding the credential. Nothing on the
  provider side may block that.
- Revocation sends a credential to a URL from discovered metadata, so it is outbound traffic
  under ADR-0108 and ADR-0139.
- The audit trail must show who removed whose authorization (ADR-0100), never a token.

## Considered Options

- **A — Sticky invalidation marks on the row; revoke at the provider, then always forget
  locally.**
- **B — Delete the row as soon as a token is refused.**
- **C — Probe the server or token endpoint on every status read.**
- **D — Forget locally only, never call the provider.**

## Decision Outcome

Chosen option: **A**.

- **A stored row is not an authorization.** Migration `0113_mcp_oauth_token_invalid` adds
  `invalid_reason` (`refresh_failed` | `rejected`) and `invalid_at`. `tokenState` derives the
  status from the row alone, nothing is contacted: a marked row is not connected; an expired
  access token without a refresh token is `expired` (computed, not stored); an expired one
  with a refresh token still counts, one refresh away from working. `auth-status` carries the
  reason as `tokenInvalid`.
- **When a mark is written.** `refresh_failed`: the token endpoint answered the refresh and
  refused it (`McpOAuthError.refused`: a non-retryable status, or a 200 without
  `access_token`). A timeout, network error, 5xx, 408, 425 or 429 leaves the row alone.
  `rejected`: the MCP server's transport refused a call that carried the token
  (`isTransportUnauthorized`: the SDKs' `UnauthorizedError`, `SseError` code 401,
  `SdkHttpError` status 401, or a plain transport error marked `(HTTP 401)`). A JSON-RPC
  error response and a tool's `isError` result never mark: the server accepted the token and
  is talking about something else.
- **Sticky, first mark wins, cleared only by a new token.** The UPDATE runs only where
  `invalid_reason IS NULL`: a refused refresh is followed by a 401 to the stale token, and the
  cause is the refusal. Only the token upsert (login or successful refresh) sets both columns
  back to NULL. A mark is written only while the row still points at the credential the
  failing request used and the vault still holds that value, so a refusal of a token that a
  re-login replaced meanwhile does not mark the new one. The row is kept, so the token can
  still be revoked or replaced.
- **Bookkeeping never changes the call.** A failed mark write is logged and dropped; the
  caller gets the same result as without it.
- **Revoke on disconnect and on server delete.** `DELETE /mcp-servers/:id/token` and
  `DELETE /mcp-servers/:id` (for every user, before the cascade) revoke the grant at the
  RFC 8414 `revocation_endpoint` with RFC 7009: the refresh token first, because it is the
  grant and its revocation ends the access tokens issued from it, then the access token. The
  refresh token's answer decides the outcome; an unconfirmed access-token revocation after
  that is only logged. Requests go through the guarded outbound POST of the OAuth client
  (ADR-0108), and a host the operator rule refuses (ADR-0139) is not contacted at all. A
  token whose issuer differs from the one the server names now is not sent there. Client
  credentials come from the stored OAuth client (ADR-0007).
- **Fail-open on revocation, fail-closed on keeping credentials.** The row and both vault
  values are removed whatever revocation did. Server delete also removes vault values that no
  row points at any more. The pooled connection that carried the token is dropped
  (ADR-0008).
- **The outcome is a contract.** `revoked` (the AS confirmed), `unsupported` (no
  `revocation_endpoint` advertised, or no metadata), `failed` (refused, unreachable, host
  refused, issuer mismatch, no stored client), `not_connected` (nothing was stored). The
  disconnect route answers `200 { revocation }` instead of `204`, so the UI can say when
  access may still be live at the provider.
- **Audited.** Each removed authorization writes `mcp_server.oauth_disconnect` with server
  name, identity, cause (`disconnect` | `server_delete`) and outcome, actor per the
  `auditActorFromRequest` rule (ADR-0100). Never a token.

### Consequences

- 🟢 **Good:** The Control Center stops calling a refused or expired authorization
  connected, and says why.
- 🟢 **Good:** A disconnect ends the grant at every provider that supports RFC 7009, and
  omadia keeps no credential after it, whatever the provider did.
- 🔴 **Bad (accepted risk):** `rejected` rests on reading transport errors. A server or proxy
  that answers HTTP 401 for a reason other than the token, or a plain transport error whose
  own message looks like an authorization failure, marks a working token. The cost is a
  "reconnect" prompt; the next login clears it.
- 🔴 **Bad (accepted risk):** At an authorization server without a revocation endpoint, or
  when revocation fails, the grant stays live there until it expires or the user revokes it
  at the provider. The outcome `unsupported` / `failed` tells the user; omadia no longer holds
  the token either way.
- 🔴 **Bad (accepted risk):** The vault and the row are separate stores. A login that lands
  between the credential check and the mark UPDATE can still be marked; the window is one
  query and the next login clears it.
- ⚪ **Neutral:** `DELETE /mcp-servers/:id/token` changed from `204` to `200` with a body.
  The web UI reads the body; a client that only checks `res.ok` is unaffected.

## Pros and Cons of the Options

### A — Sticky marks, revoke then forget

- 🟢 Status is honest without a network call; disconnect cleans up on both sides.
- 🔴 Depends on a heuristic for `rejected`; revocation is best effort.

### B — Delete the row when a token is refused

- 🟢 No new columns.
- 🔴 A false positive throws away a working refresh token, and the grant can no longer be
  revoked because omadia forgot it.

### C — Probe on every status read

- 🟢 Always current.
- 🔴 Every page view becomes outbound traffic with a credential; a slow provider slows the
  Control Center; a refresh token is spent for a display.

### D — Forget locally only

- 🟢 Simplest; no provider dependency.
- 🔴 The grant lives on at the provider after the user asked to disconnect (#1925).

## More Information

- Related: ADR-0007 (OAuth client acquisition), ADR-0008 (connection lifetime and pool
  invalidation), ADR-0100 (audit actor rule), ADR-0108 (outbound URL rules), ADR-0112 (vault),
  ADR-0139 (operator MCP host rule).
- Code: `middleware/src/services/mcpOAuthService.ts` (`tokenState`, `markTokenRejected`,
  `disconnect`, `disconnectAll`, `revokeAtProvider`), `middleware/src/services/mcpOAuthClient.ts`
  (`revoke`, `McpOAuthError.refused`),
  `middleware/packages/harness-orchestrator/src/mcp/mcpClient.ts` (`isTransportUnauthorized`,
  `onTokenRejected`), `middleware/packages/harness-orchestrator/src/registry/agentGraphStore.ts`
  (`markMcpOAuthTokenInvalid`), `middleware/src/routes/agentBuilder.ts` (auth-status,
  disconnect, server delete), `middleware/migrations/0113_mcp_oauth_token_invalid.sql`.
- Tests: `middleware/test/mcpOAuthTokenState.test.ts`, `mcpOAuthDisconnect.test.ts`,
  `mcpClient.test.ts`.
