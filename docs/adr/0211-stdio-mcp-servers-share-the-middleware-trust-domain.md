# 0211 — stdio MCP servers share the middleware's trust domain; the Compose stack ships them off

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers; Welle 5 cluster W11-12, issue #1914 (owner decision taken
  by recommendation, reversible)
- **Supersedes:** [ADR-0139](0139-mcp-operator-targets-outbound-host-rule-and-stdio-switch.md) in
  part (the stdio trust model, and the Compose default it left open)

## Context and Problem Statement

A stdio MCP server is a child process of the middleware. omadia hands it a minimal environment
(the SDK defaults plus the server's own config values), but it runs under the same OS user as
the middleware, which is PID 1 of its container. It can therefore read `/proc/1/environ`
(`VAULT_KEY`, `CREDENTIAL_KEYCHAIN_KEY`, `DATABASE_URL`, provider keys) and the data directory
(`/data/.dev-vault.key` when no `VAULT_KEY` is set, the Compose default). With those it can
decrypt every stored secret: provider keys, MCP config secrets, every user's OAuth tokens
(#1914). ADR-0139 described the child as having "the same power the admin who saves it already
has", which holds for a command the admin types but not for a catalog entry, which runs
third-party npm code the admin usually has not read. ADR-0139 kept `MCP_STDIO_ENABLED=true` and
left the Compose default open. Isolate the child, or accept and document the access?

## Decision Drivers

- No silent path from an MCP server to the middleware's keys.
- Existing installs that run stdio servers keep working without a migration.
- Real isolation (separate UID, no `/proc/1`, no `/data`) needs a privileged spawner or a
  sidecar per server, which the image does not have.

## Considered Options

- **A — Accept, document, and ship the Compose stack with stdio off.**
- **B — Isolate stdio children** (separate UID via a setuid helper or a sandbox such as
  bubblewrap, `hidepid` on `/proc`, no access to `/data`).
- **C — Remove stdio.**

## Decision Outcome

Chosen option: **A**, because it closes the default path today without a new privileged
component, and B stays possible later behind the same switch.

- **Trust model.** A stdio MCP server is inside the middleware's trust domain: it can read the
  middleware's environment and data directory and so every secret omadia stores. Saving or
  importing one is a decision to trust that code with all of it.
- **Compose ships `MCP_STDIO_ENABLED=false`** in `middleware/compose.defaults.env` (overridable
  from `middleware/.env`, pinned by `composePublicUrls.test.ts`). The built-in default in
  `config.ts` stays `true`, so a from-source run, the desktop app and existing deployments are
  unchanged.
- **The UI says so.** The stdio hint in the add-server form and the catalog card of a stdio
  entry state that the server can read the middleware's secrets.
- Everything else of ADR-0139 stands: the outbound host rule, the switch's refusal codes, the
  catalog npm-name grammar, and the audit of stdio saves.

### Consequences

- 🟢 **Good:** A fresh `docker compose up` cannot start a process that reads `VAULT_KEY`.
- 🟢 **Good:** The trust statement matches what a stdio child can actually do.
- 🔴 **Bad:** On any install with stdio on, a stdio server (and a catalog package) can still
  read every stored secret. That is an accepted risk, named in `docs/security-architecture.md`
  §10p.
- 🔴 **Bad:** A Compose operator who used stdio servers must set `MCP_STDIO_ENABLED=true` in
  `middleware/.env` after the upgrade; until then those rows are refused at connect time.
- ⚪ **Neutral:** Option B (a separate UID and a hidden `/proc` for stdio children) is the
  follow-up if stdio servers are to run safely next to the middleware's keys.

## Pros and Cons of the Options

### A — Accept, document, Compose off

- 🟢 No new component, no change for existing non-Compose installs.
- 🔴 The access stays where stdio is on.

### B — Isolate stdio children

- 🟢 The only option that removes the access.
- 🔴 Needs a privileged spawner or a sandbox binary in the image and a writable home outside
  `/data` per server; `npx` caches and config files move. Larger than this cluster.

### C — Remove stdio

- 🟢 Removes the risk.
- 🔴 Breaks every install that runs a local MCP server today.

## More Information

`middleware/compose.defaults.env`, `middleware/.env.example`, `docs/security-architecture.md`
§10p, `middleware/packages/harness-orchestrator/src/mcp/mcpClient.ts` (`makeTransport`),
`web-ui/messages/*.json` (`adminMcp.servers.stdioHint`, `adminMcp.marketplace.authHintLocal`).
