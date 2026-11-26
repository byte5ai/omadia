# 0175 — An MCP OAuth flow completes only in the session of the user who started it; authorize URLs never reach model text

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W00 security fast track; issue #1908)
- **Supersedes:** —

## Context and Problem Statement

An OAuth-protected MCP server stores one provider token per omadia user. The flow is started
for a user (`beginAuthorization(server, userKey)`) and finished at the public callback
`/api/v1/operator/mcp-oauth/callback`. The callback only looked up the flow by `state` and
stored the token under the starter's user key. `state` is a random lookup key, not proof of who
clicked: whoever opened the authorize link and logged in at the provider stored *their* provider
account under the starter's identity, and the starter's later calls ran as that other person
while `mcp_call_log` still named the starter. A tool-call auth failure also started a flow on its
own and wrote the authorize URL, `state` included, into the text the model receives, from where
it reaches run contexts and group channels. Who may finish a flow, and where may its link appear?

## Decision Drivers

- A provider account must only ever be stored under the omadia identity of the person who logged
  in at the provider ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md): one user's
  grants never become another's).
- The callback path stays public: a provider redirect must reach the handler, which renders a
  readable page instead of a JSON 401.
- The chat still needs a way to tell the user that a server needs a connection.

## Considered Options

- **A — Bind completion to the starting session and keep the link out of tool text.**
- **B — Sign `state` with the user key.** Proves the flow is ours, not who clicked.
- **C — Keep the behaviour, document that links must not be shared.**

## Decision Outcome

Chosen option: **A**.

- **Completer = starter.** `McpOAuthService.completeAuthorization(state, code, iss,
  completingUserKeyFor)` resolves the user key of the session finishing the flow for the
  flow-bound server (`resolveMcpUserKey(server, sessionIdentity(req))`). A different key, or no
  session at all, throws `McpOAuthCompleterMismatchError` before the code is exchanged: the flow
  is consumed, nothing is stored, the page says so (403).
- **Service-delegated servers** resolve every session to the shared service key, so any signed-in
  operator may finish them; every session is an operator session today (`role: 'admin'`), and
  such an operator could start that flow themselves. A browser without a session never completes
  a flow, with one exception below.
- **Desktop kernel.** The desktop app opens the Connect link in the OS browser, which holds no
  omadia session. On a kernel that is `isDesktopLoopbackKernel` (the supervisor's
  `OMADIA_DESKTOP_EMBEDDED` flag AND a literal loopback bind — the same exemption as the setup
  wizard), a session-less callback completes for the flow's starter
  (`mcpOAuthSessionlessCallback`). A callback that carries a different session is still refused.
- **Optional session on a public path.** `createOptionalSession` attaches valid session claims
  to the callback request without answering 401 itself; the handler decides what a missing
  session means. Other public paths are unchanged.
- **No authorize URL in model text.** The MCP auth-failure hook no longer starts a flow. It
  returns the connect prompt and the `<mcp-auth-required>` block; the chat's Connect card starts
  the flow from the user's own session (`POST /mcp-servers/:id/authorize`).

### Consequences

- 🟢 **Good:** A forwarded or leaked authorize link is useless to anyone but its starter.
- 🟢 **Good:** No live `state` sits in transcripts, run contexts or channel posts.
- 🔴 **Bad:** A user who starts a flow and finishes it in a browser that is not signed in to
  omadia (another device, expired cookie) gets "nothing stored" and has to sign in and connect
  again.
- 🔴 **Bad:** Channel users without an omadia login (for example a Teams user mapped only by
  e-mail) can no longer connect a per-user server from the chat; that needs a channel-side
  connect flow bound to the channel identity (follow-up).
- ⚪ **Neutral:** The provenance mint for connect prompts
  ([`mcpAuthPromptMint.ts`](../../middleware/packages/harness-orchestrator/src/mcp/mcpAuthPromptMint.ts))
  is unchanged; the prompt simply carries no URL any more.

## Pros and Cons of the Options

### A — Bind completion to the starting session

- 🟢 Closes the confused deputy at the only place a token is written.
- 🔴 Needs a session at the callback, which the public path did not read before.

### B — Sign `state`

- 🟢 No session read at the callback.
- 🔴 Proves nothing about the clicker; the link itself is the bearer secret.

### C — Document only

- 🔴 The link was produced automatically into shared text; users cannot avoid sharing it.

## More Information

- Issue #1908. Code: `middleware/src/services/mcpOAuthService.ts`,
  `middleware/src/routes/agentBuilder.ts` (callback), `middleware/src/auth/requireAuth.ts`
  (`createOptionalSession`), `middleware/src/index.ts` (`onAuthFailure`).
- Related: [ADR-0168](0168-mcp-oauth-token-lifecycle-invalidation-marks-and-revoke-on-disconnect.md)
  (token lifecycle), [ADR-0007](0007-mcp-client-id-metadata-documents.md).
