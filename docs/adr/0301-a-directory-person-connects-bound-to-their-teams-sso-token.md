# 0301 — A directory person connects a per-person MCP server bound to their Teams SSO token, never through a bearer link

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W40; issues #2312, #2335). Owner decision of 2026-11-27: no bearer connect link. Refines [ADR-0175](0175-mcp-oauth-callback-completes-only-for-the-starter.md); can be reversed.
- **Supersedes:** —

## Context and Problem Statement

[ADR-0175](0175-mcp-oauth-callback-completes-only-for-the-starter.md) lets an MCP OAuth flow
complete only in the omadia session that started it. A Teams colleague without a web login has
no such session, so a `per_user` server is unusable for them in the chat. The wave 6 proposal
for #2312 was a single-use connect link bound to the channel identity: whoever holds that link
can connect *their own* provider account into the victim's identity. The owner rejected it.
[ADR-0300](0300-entra-directory-people-anchor-channel-identities-and-per-person-tokens.md) gives
the colleague a person key (their AAD object id). How do they start and finish a flow under that
key, proven by something only they hold?

## Decision Drivers

- The completer must be the starter (ADR-0175), proven, not assumed from a link.
- No authorize URL or `state` in model text or in a channel message (ADR-0175).
- Teams already gives every tab and dialog a verified user token: Teams SSO, checked by the
  kernel ([ADR-0114](0114-teams-sso-route-auth-verified-by-the-kernel.md)).
- The provider's redirect URI stays the kernel callback; registered clients do not change.

## Considered Options

- **A — Start and complete with a Teams SSO token; the callback only hands the code back.**
- **B — Single-use bearer connect link per channel identity** (wave 6 proposal).
- **C — Give the colleague a web login for the connect.**

## Decision Outcome

Chosen option: **A**.

- **Start.** `POST /api/v1/directory/connect/mcp/:serverId/start` is a kernel route behind the
  kernel's Teams SSO verifier (ADR-0114 rules: tenant of a configured bot, audience of that
  bot, delegated user token). The token's `oid` must name an `active` directory person of the
  token's tenant; the server must exist, be OAuth-protected and `per_user` (a service-delegated
  server is an operator matter). The kernel begins the flow under the person key (the `oid`)
  and marks it `completion = 'teams-sso'` (migration 0124), with the person as initiator
  (`directory:<id>`, [ADR-0246](0246-attribute-mcp-oauth-connect-to-initiator.md)). The answer
  is a `startUrl` on the deployment's own host, `/api/v1/directory/connect/go/<state>`, which
  redirects to the provider's authorize URL stored with the flow: Teams' authentication window
  must start on a valid domain of the app. Nothing reaches the model or a channel message.
- **Which servers.** A turn whose tool call got a kernel-minted connect prompt (ADR-0175
  provenance, never server text) reports the server in `ChatTurnResult.mcpConnectRequired` /
  `SemanticAnswer.mcpConnectRequired` (channel-sdk, additive): channels see no tool output.
- **The page.** The Teams plugin serves the connect page and puts a Connect action on the
  answer for each server in `mcpConnectRequired`. The page gets an SSO token from Teams, calls
  start, and opens `startUrl` with Teams' authentication window.
- **Callback.** For a `teams-sso` flow the public callback exchanges nothing. It renders a
  page that returns `state`, `code` and `iss` to the Teams authentication window
  (`authentication.notifySuccess`) and closes. A browser outside Teams gets a page saying to
  finish in Teams.
- **Complete.** `POST /api/v1/directory/connect/mcp/complete` with the SSO token and
  `{ state, code, iss }`. The kernel resolves the completer key from the token (`oid` of an
  active person) and calls `completeAuthorization` with it: a different key, or a flow not
  marked `teams-sso`, is the existing `McpOAuthCompleterMismatchError` (flow consumed, nothing
  stored, 403). A `teams-sso` flow can never complete through the session path, and a
  session flow never through this one.
- **Where it works.** Teams only, because only Teams gives a verified user token. A person
  linked from Telegram (ADR-0300) connects once in Teams or, with a web login, on the web; the
  token serves their linked channels too. No connect link is ever sent anywhere.

### Consequences

- 🟢 **Good:** A forwarded authorize URL or callback page is useless: completing needs the
  starter's own Teams SSO token.
- 🟢 **Good:** No new secret, no link table, no change to registered redirect URIs.
- 🔴 **Bad:** Needs the Teams app manifest's SSO setup (`webApplicationInfo`) that the tab
  catalogue already uses; a tenant without it cannot connect from Teams.
- 🔴 **Bad:** Channels without a verified user token (Telegram, WhatsApp) have no connect of
  their own.
- 🔴 **Bad (accepted):** Whoever holds a flow's `state` can use it up (a completion with
  another token consumes the flow, by design: a stray code must not stay redeemable); the person
  starts Connect again.
- ⚪ **Neutral:** The connect servers are collected per turn (the turn context); a
  subscription-CLI turn's loopback calls do not report them yet.
- ⚪ **Neutral:** The hand-back page sends its own CSP (hash of its one inline script, the Teams
  SDK with subresource integrity) and reflects at most 4 KB of `state`/`code`.
- ⚪ **Neutral:** The Teams plugin renders the Connect card and serves the page
  (byte5ai/omadia-channel-teams).

## Pros and Cons of the Options

### A — Teams SSO start and complete

- 🟢 Binds completion to a token only the person holds, as the session does on the web.
- 🔴 Teams-specific.

### B — Bearer connect link

- 🟢 Works on every channel.
- 🔴 The link holder connects their own provider account into the victim's identity
  (rejected by the owner).

### C — A web login for the connect

- 🔴 Every account is an administrator ([ADR-0113](0113-sign-in-providers-behind-one-contract-and-a-single-admin-role.md)).

## More Information

- Code: `middleware/src/directory/directoryConnectRoutes.ts` (routes + `/go` redirect),
  `middleware/migrations/0124_mcp_oauth_flow_completion.sql`,
  `packages/harness-orchestrator/src/mcp/mcpAuthPromptMint.ts` (`parseMcpConnectRequest`),
  `middleware/src/services/mcpOAuthService.ts`, the callback in
  `middleware/src/routes/agentBuilder.ts`, `middleware/src/auth/teamsSsoVerifier.ts`.
- Related: [ADR-0168](0168-mcp-oauth-token-lifecycle-invalidation-marks-and-revoke-on-disconnect.md), [ADR-0105](0105-one-api-session-gate-and-a-closed-public-path-list.md).
- Border: auth / MCP / channels.
