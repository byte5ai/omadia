# 0141 — The public chat API is a channel plugin; callers are server-side API keys with exact scopes, kept as hashes in the vault

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issues #438 (public API channel) and #439 (shared key
  authentication), implemented in #549; binding per key in #1106
- **Supersedes:** —

## Context and Problem Statement

External systems (a CRM, a back office job) should be able to ask an omadia agent a question
without the operator UI and without writing a channel adapter. That needs a public,
documented route that is not behind the operator session, and an identity for callers who are
programs, not people. This record is retroactive. How is that route built, and what is an API
key allowed to be?

## Decision Drivers

- No second turn path: an external call is a channel turn like any other.
- A key is a server credential; nothing about it may be recoverable from storage.
- Least privilege (ADR-0016): a key reaches one capability unless more is named.
- The same key store must serve further public surfaces
  ([ADR-0143](0143-public-mcp-endpoint-is-stateless-and-default-deny.md)).
- No database migration for the first version (design decision on #438).

## Considered Options

- **A — A built-in `kind: channel` plugin with one self-authenticating route; API keys with
  exact-match scopes, stored as sha256 hashes in the plugin's vault namespace; the
  authentication primitives in a shared package.**
- **B — Let external callers use the operator session routes** (`/api/chat`) with a service
  account.
- **C — OAuth 2.0 client credentials** with an authorization server in the kernel.

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-channel-api/`,
`middleware/packages/harness-api-key-auth/`).

- **One public route.** `POST /api/public/v1/chat` is the only path this plugin exempts from
  the session gate. It calls `CoreApi.handleTurnStream`, so routing, Privacy Shield, the
  verifier and AI disclosure apply as on every channel.
- **Key administration stays behind the operator session.** `/api/public/v1/admin/keys` is
  not exempted and is additionally gated inside `adminKeysRouter.ts` through
  `ctx.operatorAuth`, because `core.registerRouter` applies no authentication of its own.
- **Keys.** Prefix `omk_`; the plaintext is shown once at creation; only its sha256 hex is
  stored (`apiKeyToken.ts`, `apiKeyStore.ts`). Revocation takes effect on the next call. A key
  is an identity in its own right, not a delegate of a human.
- **Scopes are exact.** `<resource>:<action>` strings or the global `*`; no prefix wildcards.
  `/chat` requires `chat:write`, the default of a key created without scopes. `"scopes": []`
  is a `400`. A key whose stored scopes cannot be read is denied every capability (`403`), not
  given a default.
- **Status convention.** `401` unknown or revoked key, `403` missing scope, `429` over the
  per-key budget (fixed 60-second window, in memory, no `Retry-After`), `415` without
  `application/json`, `400 invalid_request` for any unknown body field (strict schema).
- **Response is always an NDJSON stream**, in the event vocabulary the other channels consume.
  `done.answer` is authoritative; `text_delta` is a preview. No non-streaming variant.
- **Conversation scope is namespaced per key.** `conversationId` continues a conversation for
  that key only. The identifier `key:<uuid>` is the caller's `ChannelUserRef.id`, the routing
  `channelKey` and the row in the channel directory (`channelKey.ts`), so an operator can bind
  a key to an agent like any other channel key (#1106).

### Consequences

- 🟢 **Good:** External integrations inherit every kernel control of a channel turn.
- 🟢 **Good:** One key list and one revoke for the chat API and the public MCP endpoint.
- 🔴 **Bad:** Rate limits are per process and per limiter: with several instances, or with
  chat and MCP together, a key gets a multiple of `rateLimitPerMinute`.
- 🔴 **Bad:** Keys and the usage log live in the vault, not in a table: no SQL over keys, and
  the plugin needs `secrets.runtime_write`.
- 🔴 **Bad:** A key carries no end-user identity; per-person rights and memory do not apply to
  API turns.
- ⚪ **Neutral:** The manifest declares `transport.kind: webhook` with
  `verify_signature: false`, because the router authenticates the caller itself.

## Pros and Cons of the Options

### A — Channel plugin, hashed scoped keys

- 🟢 Small, auditable, reusable by other public routes.
- 🔴 Bearer keys are long-lived secrets on the caller's side.

### B — Operator session routes with a service account

- 🟢 Nothing to build.
- 🔴 A service account holds an operator session with every admin route behind it.

### C — OAuth client credentials

- 🟢 Short-lived tokens, standard tooling.
- 🔴 An authorization server in the kernel for a server-to-server call that gains little from it.

## More Information

- Consumer documentation: `middleware/packages/harness-channel-api/README.md`;
  `docs/security-architecture.md` §9.
- Tests: `middleware/test/channelApi/` (`chatRouter.test.ts`, `adminKeysRouter.test.ts`,
  `apiKeyLifecycle.test.ts`, `apiKeyToken.test.ts`, `publicPathsExemption.test.ts`,
  `apiChannelBindingRouting.test.ts`).
