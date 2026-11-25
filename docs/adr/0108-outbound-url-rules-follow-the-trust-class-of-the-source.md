# 0108 — Outbound requests: the rule follows who chose the URL; untrusted targets are checked at connect time

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main). The
  connect-time guard is #91 (PR #113); the MCP OAuth guard epic #459 W9 (PR #550); the
  operator outbound rule #1341 / #1342 (PR #1423); Conductor webhooks #437.

## Context and Problem Statement

This record is retroactive: it documents rules that are implemented on main.

The kernel opens connections to URLs that come from very different places: an administrator
types an MCP server endpoint, a third-party MCP server names its OAuth authorization
server, a registry catalog lists endpoints, a web-scanner plugin fetches whatever a user
pasted, a Conductor workflow posts a webhook. Each is a server-side request forgery vector
toward loopback, the private network and the cloud metadata address. One strict rule for
all of them would forbid legitimate setups (an MCP server on the intranet, a Compose service
name); one loose rule would let a hostile authorization server collect authorization codes
on `127.0.0.1`. Which rule applies where, and when is the address checked?

## Decision Drivers

- Tokens, codes and secrets must never be sent to an address a third party steered inward.
- An operator's own intranet targets must keep working.
- A check on the hostname alone is defeated by DNS rebinding.
- One predicate per trust class, shared by every call site of that class.

## Considered Options

- **A — Rules by trust class of whoever chose the URL; a connect-time guarded agent for
  untrusted sources.**
- **B — One strict rule: public https only, everywhere.**
- **C — Hostname check before the request only.**
- **D — No in-process rule; rely on network policy of the deployment.**

## Decision Outcome

Chosen option: **A**.

- **Untrusted sources: public addresses only, enforced at connect time.**
  `createGuardedAgent()` (`platform/ssrfGuard.ts`) is an undici dispatcher whose `lookup`
  resolves the name, refuses the connection if any resolved address is non-public (loopback,
  private, link-local, ULA, CGNAT, multicast, reserved, unspecified), fails closed on a
  lookup error and hands undici exactly the address it validated. A literal-IP pre-check
  covers the case where no lookup happens. Used by:
  - plugin `ctx.http` in `public-web` mode (`platform/httpAccessor.ts`);
  - Conductor webhooks, lifecycle dispatcher and `webhook.post` alike
    (`conductor/webhookOutbound.ts`, http or https);
  - MCP OAuth and discovery traffic, the default `fetch` of those clients
    (`services/guardedOutboundFetch.ts`).
- **`assertPublicHttpsUrl`** (`services/ssrfGuard.ts`: https only, non-internal literal host,
  non-internal resolved addresses, callers pass `redirect: 'error'`) stays at the untrusted
  call sites as a cheap pre-check with a better error. It is not what enforces the
  boundary. Endpoints taken from a registry catalog keep this stricter rule
  (`assertUntrustedEndpointSafe`).
- **Operator configuration: only the metadata pivot is refused.** An MCP registry URL and a
  manually added `http`/`sse` MCP endpoint (`services/mcpOutboundHostGuard.ts`) are refused
  for IPv4 `169.254.0.0/16`, IPv6 `fe80::/10`, the AWS and GCP IPv6 metadata addresses,
  `169.254.x` embedded in IPv6 forms, and the metadata hostnames. Private ranges, Compose
  service names and loopback stay allowed. Checked on save (`400 … code: blocked_host`) and
  on every connect, so a row saved before the rule existed is refused there.
- **Plugins are confined first.** A plugin reaches only its manifest hosts (`single-host`),
  plus operator-listed hosts (`allowlist`), or any public host (`public-web`, only for
  `web_scanner` plugins). The process-wide egress guard (ADR-0017) applies the same
  permission to global `fetch` and `node:http(s)`.
- **Brokered credentials go only to the declared host**, and redirects are never followed
  ([ADR-0102](0102-credential-broker-stamps-secrets-and-owner-only-asks.md)).
- **stdio is not a URL.** A stdio MCP server is a command the kernel starts as its own OS
  user. `MCP_STDIO_ENABLED=false` switches the transport off; the default is `true`.

### Consequences

- 🟢 **Good:** OAuth codes, PKCE verifiers and refresh tokens cannot be steered to an
  internal address by a rebinding name.
- 🟢 **Good:** Intranet MCP servers and registries work without an escape hatch.
- 🔴 **Bad:** The operator rule has a rebinding gap, accepted: the MCP SDK transports and the
  registry fetch resolve the name again when they connect and expose no way to pin the
  checked address. Redirect handling there is the SDK's default, not an omadia control.
- 🔴 **Bad:** The operator rule is a meaningful control only with `MCP_STDIO_ENABLED=false`;
  with stdio on, the same administrator can start any process anyway.
- 🔴 **Bad:** Two modules are named `ssrfGuard.ts` (`platform/` and `services/`) with
  separately written range predicates (`isPublicIp` and `isInternalHost` / `isInternalIp`).
- ⚪ **Neutral:** A pooled MCP connection is reused without a new check; changing the rule
  needs a restart.

## Pros and Cons of the Options

### A — Rule by trust class, connect-time guard

- 🟢 Strict where a stranger chose the URL, permissive where the administrator did.
- 🔴 Several rules to know; a new call site must pick its class consciously.

### B — Public https only

- 🟢 One rule.
- 🔴 Forbids the intranet MCP server and the Compose service name.

### C — Check before the request

- 🟢 Simple.
- 🔴 Two lookups, two answers: public for the check, `169.254.169.254` for the fetch.

### D — Network policy only

- 🟢 No code.
- 🔴 The desktop app and a default Compose install have none.

## More Information

- Code: `middleware/src/platform/ssrfGuard.ts`, `platform/httpAccessor.ts`,
  `platform/pluginEgressGuard.ts`, `middleware/src/services/{ssrfGuard,guardedOutboundFetch,mcpOutboundHostGuard,mcpRegistryClient,mcpCimd}.ts`,
  `middleware/src/conductor/webhookOutbound.ts`.
- Tests: `middleware/test/{ssrfGuard,guardedOutboundFetch,mcpOutboundHostGuard,pluginEgressGuard}.test.ts`.
- Docs: `docs/security-architecture.md` §4 (plugin network sandbox), §7, §10p.
- Related: ADR-0007 (CIMD probe reuses `assertPublicHttpsUrl`), ADR-0008, ADR-0017, ADR-0041.
- Border: MCP / integrations, Conductor, plugin platform.
