# 0164 — Plugin OAuth runs in a kernel broker driven by a declarative provider descriptor

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); design in
  `specs/005-declarative-oauth-broker-atlassian/spec.md` (decisions E1–E5), implemented in
  #325; tool readiness from #474
- **Supersedes:** —

## Context and Problem Statement

A plugin that connects to a service with OAuth 2 needs an authorization-code flow, a place
for the tokens and a refresh. ADR-0054 states in one bullet that OAuth is kernel-owned. It
does not record how a provider is described, how the callback is secured, who refreshes, or
what a plugin sees. This record is retroactive. How does a plugin get OAuth credentials
without a core change per provider and without holding a refresh token?

## Decision Drivers

- A new identity provider must not need a kernel pull request.
- Client secret and refresh token must not reach plugin code.
- The callback arrives from the provider's redirect, possibly after the operator session
  lapsed.
- A plugin whose connection is missing must not offer tools that fail on first use.

## Considered Options

- **A — A generic engine in the kernel, driven by an inert descriptor in the manifest.**
- **B — One provider class per identity provider in the kernel.**
- **C — Plugins register a provider at runtime** (a `ctx.oauth.registerProvider` hook).
- **D — Each plugin runs its own flow** and stores tokens as ordinary secrets.

## Decision Outcome

Chosen option: **A** (`middleware/src/plugins/oauth/`).

- **The descriptor is data.** A manifest lists `oauth_providers`
  (`OAuthProviderDescriptor`: `id`, `authorize_url`, `token_url`, `token_auth_style`, `pkce`,
  `extra_authorize_params`, `client_id_field`, `client_secret_field`). A setup field of type
  `oauth` names one by `provider`. URLs may carry `{field}` placeholders filled from the
  plugin's stored config. `engine.ts` knows three token styles: `body_form`, `body_json`,
  `basic`. There is no per-provider class.
- **The plugin brings its own OAuth app.** Client id and client secret are ordinary setup
  fields of that plugin; `resolveOAuthProvider` reads the id from its config and the secret
  from its vault namespace. The broker and the token accessor share this one resolver.
- **One connection per plugin and field.** Tokens are stored as one JSON value in the
  plugin's vault namespace under `oauth.<fieldKey>`, so the credentials editor, which lists
  bare field keys, never shows them.
- **Start is gated, callback is public and self-securing.** `/api/v1/install/oauth/start`
  stays behind the session gate. `/api/v1/install/oauth/callback` is on the static public
  path list (ADR-0105) and trusts only the `state`: a JWT (HS512, audience `plugin-oauth`,
  10 minutes) signed with the session signing key, carrying `flowId`, `pluginId`,
  `providerId`, `fieldKey`. The audience keeps it apart from session tokens.
- **The flow is single-use.** The PKCE verifier (S256) and the scopes stay server-side in
  `PendingFlowStore` (in memory, 10 minutes). The callback takes the entry before anything
  else and refuses a flow whose plugin differs from the one in the state.
- **The callback never throws to the browser.** Every outcome is a redirect to the store
  page with `connected=ok|error` and a short reason. After success the plugin is
  re-activated, best effort.
- **The kernel refreshes.** `ctx.oauthTokens.get(fieldKey)` exists only when the manifest
  has an `oauth` field. It returns an access token and refreshes inside the kernel when less
  than `OAUTH_REFRESH_MARGIN_MS` (5 minutes) is left; a rotated refresh token replaces the
  stored one, an omitted one keeps it. Failures are `OAuthTokenError('not_connected')` or
  `('refresh_failed')`.
- **Connection state gates tools.** `OAuthReadinessTracker` caches the stored tokens per
  activation and evaluates freshness at read time with the same rule as the accessor. The
  kernel's `installedPluginToolsReadyReader` requires both it and the plugin's own status
  report; otherwise the plugin's tools are neither listed nor dispatched.

### Consequences

- 🟢 **Good:** A plugin adds a provider with manifest data; the descriptor can be reviewed
  before install and no plugin code runs during the flow.
- 🟢 **Good:** A plugin only ever receives an access token.
- 🔴 **Bad:** Pending flows live in one process. With more than one kernel instance a
  callback can land where the flow is unknown and ends as `expired`; the file comment names
  a shared table as the follow-up.
- 🔴 **Bad:** Only what the descriptor can express is supported: authorization code with
  optional PKCE and refresh, three ways to present client credentials. No device flow, no
  client-credentials grant, no per-user connections (spec E4 defers them).
- 🔴 **Bad:** The state is signed with the session signing key; the two token families are
  separated by the audience claim only.
- ⚪ **Neutral:** Provider-specific steps after the first token (for Atlassian, resolving
  the cloud id) are the plugin's job (spec E6). The PKCE helpers live in
  `@omadia/plugin-api`, shared with plugins that run a redirect flow of their own.

## Pros and Cons of the Options

### A — Generic engine, inert descriptor

- 🟢 No core change per provider; secrets stay in the kernel.
- 🔴 Bounded by the descriptor's vocabulary.

### B — Provider classes in the kernel

- 🟢 Any dialect can be coded.
- 🔴 Every provider is a core pull request (spec E1).

### C — Runtime-registered providers

- 🟢 Flexible without a core change.
- 🔴 Plugin code would run in the exchange and see the refresh token (spec E2, E3).

### D — Flow inside each plugin

- 🟢 No kernel surface.
- 🔴 Each plugin needs its own callback route, state handling and refresh; client secret and
  refresh token live in plugin code.

## More Information

- Related: ADR-0054 (setup fields and the per-plugin vault), ADR-0105 (public path list),
  ADR-0112 (vault key), ADR-0106 (session signing key). Separate mechanisms that are not
  this broker: OAuth towards MCP servers (`mcpOAuthService`), subscription logins
  (ADR-0086), the credential keychain broker (ADR-0102).
- Code: `middleware/src/plugins/oauth/` (`engine.ts`, `brokerService.ts`,
  `providerResolve.ts`, `state.ts`, `pendingFlows.ts`, `tokenStore.ts`,
  `oauthReadinessTracker.ts`, `pkce.ts`); `middleware/src/routes/install.ts`;
  `middleware/src/auth/publicPaths.ts`; `middleware/src/platform/pluginContext.ts`
  (`ctx.oauthTokens`); `middleware/src/api/admin-v1.ts` (`OAuthProviderDescriptor`).
- Tests: `middleware/test/oauth/` (`engine`, `brokerService`, `state`, `pendingFlows`,
  `pkce`, `oauthReadinessTracker`), `pluginContextOAuthTokens.test.ts`,
  `manifestOAuthProviders.test.ts`, `installServiceOAuthField.test.ts`.
