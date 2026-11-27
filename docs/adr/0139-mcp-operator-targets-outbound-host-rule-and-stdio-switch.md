# 0139 — Operator-configured MCP targets: private hosts allowed, link-local and metadata refused, stdio switchable

## Status

Accepted — superseded in part by [ADR-0211](0211-stdio-mcp-servers-share-the-middleware-trust-domain.md) (stdio trust model; the Compose stack ships stdio off)

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issues #1341 and #1342, implemented in #1423
- **Supersedes:** —

## Context and Problem Statement

An operator registers MCP servers and MCP registries in the admin UI. A remote server
(`http`, `sse`) is a URL the middleware connects to; a `stdio` server is a command line the
middleware starts as its own child process, with its OS user, filesystem and network. Both are
ways to make the middleware reach something: a cloud metadata address in the first case, any
program in the second. This record is retroactive. Which targets may an operator configure,
where is that checked, and can stdio be turned off? (Border: security.)

## Decision Drivers

- An MCP server or registry on the intranet, or a Compose service name, is a legitimate setup.
- Link-local and cloud-metadata addresses are the classic SSRF pivot and never a legitimate
  MCP target.
- Rows saved before a rule existed must be covered too.
- Existing installations must keep working after an upgrade.

## Considered Options

- **A — One operator outbound rule (private and loopback allowed, link-local and metadata
  refused), checked on save and on every connect; stdio behind `MCP_STDIO_ENABLED`, default on.**
- **B — The untrusted rule for everything** (https only, no private or loopback host).
- **C — No rule for operator configuration**, since the operator is an admin.

## Decision Outcome

Chosen option: **A** (`middleware/src/services/mcpOutboundHostGuard.ts`).

- **One implementation** for registry URLs and manual `http`/`sse` endpoints. Operator
  configuration is the trust class of an SMTP relay: `10/8`, `172.16/12`, `192.168/16`,
  service names and loopback stay reachable.
- **Refused:** link-local addresses including their IPv6 embeddings, the metadata host names
  `metadata.google.internal`, `metadata.goog` and `metadata`, and the IPv6 metadata endpoints
  `fd00:ec2::254` and `fd20:ce::254`. The check runs on the literal host and on every address
  it resolves to.
- **Checked twice.** On save: `400` with `code: blocked_host`. On every connect, through
  `createMcpConnectGuard` wired into the MCP manager: Discover, re-scan, the periodic re-scan
  and runtime tool calls, so an older row reports `blocked_host` instead of a bare transport
  failure.
- **Catalog endpoints keep the stricter untrusted rule** (`assertUntrustedEndpointSafe` in
  `mcpRegistryClient.ts`): https only, no private or loopback host.
- **stdio switch.** `MCP_STDIO_ENABLED` (default `true`). With `false`, creating a stdio
  server is refused manually and by catalog import (`400 mcp_stdio_disabled`,
  `code: stdio_disabled`), and an existing stdio row is refused at connect time without a
  process being started. Catalog imports only ever write `npx -y -- <package>` with the name
  checked against a strict npm-name grammar; a manual entry accepts any command.
- **Audit of stdio saves** logs id, name and source, not the command line, which can carry
  secrets in its arguments.

### Consequences

- 🟢 **Good:** The metadata pivot is closed for every operator-configured MCP target, old rows
  included.
- 🟢 **Good:** A deployment that uses only remote servers can remove the process-spawning
  transport entirely.
- 🔴 **Bad:** DNS rebinding is not covered: the address is resolved for the check and again by
  the transport; neither the registry fetch nor the MCP SDK transports allow pinning.
- 🔴 **Bad:** Redirects are not re-checked by omadia; that the SDK transports follow only
  same-origin redirects is the SDK's default, not an omadia control.
- 🔴 **Bad:** A pooled connection (ADR-0008) is reused without a new check; changing the rule
  or the switch needs a restart.
- 🔴 **Bad:** With stdio on, an admin can run any command in the middleware container, so the
  host rule is a meaningful SSRF control only with `MCP_STDIO_ENABLED=false`.
- ⚪ **Neutral:** Whether Compose deployments should ship with stdio off is recorded as open in
  `docs/security-architecture.md` §10p.

## Pros and Cons of the Options

### A — Operator rule plus stdio switch

- 🟢 Keeps intranet setups, closes the pivot, backwards compatible.
- 🔴 Two host rules (operator, untrusted) to keep apart.

### B — Untrusted rule everywhere

- 🟢 One rule, strongest.
- 🔴 Breaks every MCP server on a private network or in the same Compose stack.

### C — No rule

- 🟢 Nothing to maintain.
- 🔴 A mistyped or malicious URL reaches instance credentials; "the admin could anyway" only
  holds while stdio is on.

## More Information

- Related: ADR-0007 (the CIMD probe uses the public-https guard), ADR-0008.
- Config: `middleware/src/config.ts` (`MCP_STDIO_ENABLED`), `middleware/.env.example`,
  `docs/upgrading.md`.
- Tests: `middleware/test/mcpOutboundHostGuard.test.ts`,
  `middleware/test/mcpServerEndpointGuardRoute.test.ts`,
  `web-ui/app/admin/mcp/__tests__/outboundGuard.test.tsx`.
