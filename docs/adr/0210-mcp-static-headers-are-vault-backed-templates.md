# 0210 — Static MCP headers and API keys are Vault-backed templates, never row values

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers; Welle 5 cluster W11-12, issue #1912
- **Supersedes:** —

## Context and Problem Statement

Most remote MCP servers need a static credential: an API key in a header (`x-api-key`,
`Authorization: Bearer …`) or in the URL. `mcp_servers.headers` existed, but no route wrote it.
The only workaround was a `{placeholder}` in the endpoint: left non-secret, the key sat in
clear text in `mcp_servers.config` and came back from `GET …/config`; marked secret, Discover
failed with `422 mcp_endpoint_placeholder`, because secrets were filled into headers only. The
config schema was derived from the placeholders only while it was empty, and nothing removed a
secret whose field had gone (#1912). Where does an operator-set static credential live, and how
does it reach the connection?

## Decision Drivers

- A credential is never stored on the DB row, returned by a route, or shown again
  (ADR-0112: the Vault is the at-rest store for secrets; ADR-0054: typed secret fields are
  validated server-side and written to the Vault, never echoed).
- One mechanism for header and endpoint credentials, reusing the epic-#459 config fields.
- Changing endpoint or headers must not leave orphaned fields or secrets.

## Considered Options

- **A — Header templates on the row, values as secret config fields in the Vault.**
- **B — A dedicated encrypted `mcp_servers.secret_headers` column.**
- **C — Keep endpoint placeholders only, never headers.**

## Decision Outcome

Chosen option: **A**, because it adds no second secret store and makes the existing config
fields work wherever their placeholder appears.

- **Headers are templates.** `PUT /api/v1/operator/mcp-servers/:id/headers` (and `headers` on
  `POST /mcp-servers`) takes `[{ name, value?, secret }]`. A plain header is stored as typed; a
  secret header is stored as `{header_<name>}` and its value goes to the Vault
  (`@omadia/mcp-config`, key `<serverId>:header_<name>`). A secret header sent without a value
  keeps the stored one. `GET …/headers` returns names and `secretSet`, never a secret value.
- **Names and values are checked:** RFC 9110 token names, no transport-owned names (`Host`,
  `Content-Type`, `Accept`, `Mcp-Session-Id`, …), no duplicates, no CR/LF, at most 20 headers
  and 8192 characters per value. `Authorization` is allowed; on a server that also runs OAuth
  the OAuth token wins. stdio servers take environment variables, not headers.
- **Secret fields work in the endpoint too.** `McpConfigService.getConfigEndpoint` fills secret
  placeholders per call (`McpAuthProvider.getConfigEndpoint`), the Discover placeholder guard
  counts a secret with a stored value as configured, and the connect guard (ADR-0139) checks
  the final URL.
- **The schema follows the placeholders.** For http/sse servers the config schema is reconciled
  with endpoint and header placeholders on every read and save (`reconcileConfigSchema`): new
  placeholders appear, existing labels and secret flags are kept, gone fields are dropped and
  their Vault secrets deleted. stdio schemas (environment variables) are left as declared.

### Consequences

- 🟢 **Good:** An API key never lands in `mcp_servers.config` or a response.
- 🟢 **Good:** The config form and the header editor can no longer drift from the
  placeholders that are actually there.
- 🔴 **Bad:** A secret in the endpoint URL can be quoted by a transport or upstream error
  message (and so reach the log or the last re-scan error); the UI recommends a header.
- 🟢 **Good:** Deleting a server deletes its config secrets from the Vault too.
- ⚪ **Neutral:** A changed header or secret drops the pooled connection (ADR-0008) through
  the same invalidation the config route uses.
- ⚪ **Neutral:** The catalog import still passes no headers; a catalog server gets its key in
  the header editor after import.

## Pros and Cons of the Options

### A — Templates plus secret config fields

- 🟢 One store, one substitution path, existing UI concepts.
- 🔴 The `header_` field-key prefix is a convention the form has to know.

### B — Encrypted column

- 🟢 Headers self-contained on the row.
- 🔴 A second at-rest encryption scheme next to the Vault.

### C — Endpoint placeholders only

- 🟢 No new route.
- 🔴 Many servers accept keys only in headers; URL keys leak through error messages.

## More Information

`middleware/src/services/mcpStaticHeaders.ts`, `middleware/src/services/mcpConfigService.ts`,
`middleware/src/routes/agentBuilder.ts` (`applyServerHeaders`, `/mcp-servers/:id/headers`),
`web-ui/app/admin/mcp/ServerHeadersForm.tsx`; tests `middleware/test/mcpStaticHeaders.test.ts`,
`web-ui/app/admin/mcp/__tests__/serverHeadersForm.test.tsx`.
