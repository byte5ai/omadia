# 0208 — Switching an MCP server to service delegation is confirmed and audited; reading OAuth status registers nothing

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W09-10; decided after the recheck recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

`service` delegation makes every chat, routine and workflow that calls an MCP server act
under one shared authorization. The switch took one unconfirmed click in the Control Center,
the Conductor dialog flipped it for the whole server without saying so, nothing was
audited, and under `service` the status called the shared token "yours" (#1933).
Separately, merely viewing a server's OAuth status probed Dynamic Client Registration by
registering a real client at the provider, which was never removed (#1947), and every
provider-configuration error read as "isn't set up yet" (#1924). Servers off public https
got a raw 401 instead of the reason ADR-0108 already decided (#1929).

What does it take to switch a server to `service`, and what may a status read do at the
provider?

## Decision Drivers

- A change of whose credentials every caller uses is an operator decision that must be
  deliberate and traceable (ADR-0100).
- A read must not have side effects at a third party.
- Error text must name the real cause.

## Considered Options

- **A — Confirmation in the API contract plus admin audit; status reads report DCR as advertised**
- **B — Confirmation only in the UI**
- **C — Keep probing DCR on status reads, but delete the probe client afterwards**

## Decision Outcome

Chosen option: **A**.

- `PUT /mcp-servers/:id/delegation` with `delegation: 'service'` from `per_user` answers
  `409 delegation_confirmation_required` (`affects: chats, routines, workflows`) unless the
  body carries `confirm: true`. The UI asks first, naming that scope; the Conductor dialog's
  notice says the switch applies to the whole server. Every change is written to the admin
  audit (`mcp_server.delegation_change`, before/after). A malformed id is 404 (ADR-0038).
- Under `service`, `auth-status` says `sharedAuthorization: true`; the UI shows a shared
  authorization and asks before Connect or Disconnect replaces or removes it for all callers.
- `describeAuth` reports DCR as advertised and never registers. Registration happens on
  Connect; an issuer whose DCR then declines is remembered and reported as needing a manual
  client. When the last server of an issuer is deleted, its stored client and vault secret
  are removed (`McpOAuthService.forgetClient`); the registration at the provider stays (RFC
  7592 management is optional and the needed token is not kept).
- A provider configuration that cannot be used is reported with its reason
  (`discoveryError` in `auth-status`, `422 mcp_oauth_discovery_failed` from `/authorize`, a
  named message in chat). Only `McpOAuthNeedsClientError` yields the registration hint. A
  server off public https that refuses a call for authorization gets "OAuth only for public
  https servers" (ADR-0108 stays as decided).

### Consequences

- 🟢 **Good:** Nobody shares one token across all callers by accident, and the audit shows who did.
- 🟢 **Good:** Looking at a server leaves no trace at the provider.
- 🔴 **Bad:** API clients that switched delegation without `confirm` now get 409.
- 🔴 **Bad:** A gated DCR issuer reads as zero-setup until its first Connect in this process.
- ⚪ **Neutral:** Who stored the shared token is not recorded yet; the status says "shared".

## Pros and Cons of the Options

### A — API-level confirmation, audit, no side-effect reads

- 🟢 Holds for every client, not just the web UI.
- 🔴 One more field in the request.

### B — UI-only confirmation

- 🟢 No API change.
- 🔴 Scripts and other UIs can still flip the mode silently.

### C — Probe and clean up

- 🟢 Status stays exact for gated DCR.
- 🔴 Still a write at the provider on every read, and cleanup can fail.

## More Information

- Issues #1924, #1929, #1933, #1947.
- Implementation: `middleware/src/routes/agentBuilder.ts` (delegation, auth-status, authorize,
  server delete), `middleware/src/services/mcpOAuthService.ts` (`describeAuth`, `forgetClient`,
  messages), `middleware/src/index.ts` (`onAuthFailure`), `web-ui/app/_components/mcp/McpAuthSection.tsx`.
- Tests: `middleware/test/mcpAuthDiscoveryUnavailable.test.ts`, `middleware/test/mcpOAuth.test.ts`,
  `web-ui/app/_components/mcp/__tests__/McpAuthSection.test.tsx`.
