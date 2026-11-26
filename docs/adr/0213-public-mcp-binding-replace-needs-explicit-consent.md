# 0213 — Replacing a public MCP key binding needs explicit consent; dead keys are named

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers; Welle 5 cluster W11-12, issue #1949
- **Supersedes:** —

## Context and Problem Statement

A key has exactly one `public_mcp_key_bindings` row (ADR-0143). `POST
/api/v1/operator/public-mcp-bindings` upserted per `key_id`: saving for a key that already had a
binding replaced agent, read tools, write tools and write budget with `200` instead of `201`, and
the pane ignored the status. A mistyped or already-bound key id silently wiped someone's binding.
The list also flagged every revoked or expired key as "no API key with this id exists — check for
a typo" while the badge said "Active" (#1949). What does the write contract promise about an
existing binding, and how is a binding whose key cannot authenticate reported?

## Decision Drivers

- The binding row is the whole authorization of an internet-facing key; overwriting it must be
  a deliberate act.
- An operator must be able to tell "typo" from "revoked" from "expired".
- The read path (the endpoint) stays unchanged.

## Considered Options

- **A — 409 unless `replace: true`, key states as warning codes.**
- **B — Keep the upsert, report "replaced" afterwards.**
- **C — Separate create (`POST`) and update (`PUT /:keyId`) routes.**

## Decision Outcome

Chosen option: **A**, because it refuses the destructive case before it happens with the
smallest contract change.

- `POST /public-mcp-bindings` for a key that already has a row answers
  **`409 {"error":"conflict","code":"binding_exists","binding":{…}}`** with the stored row and
  writes nothing. With `"replace": true` it overwrites and answers `200` (a new row stays `201`).
  A non-boolean `replace` is `400 replace_invalid_type`. The pane shows the stored binding in a
  confirm dialog and resends with `replace: true`.
- `BindingExistenceCheck.keyStates()` reports each vault key as `active`, `revoked` or
  `expired`; the warning codes are `key_revoked`, `key_expired` and `key_id_unknown` (only the
  last one mentions a typo). A binding whose key cannot authenticate gets a "Key inactive"
  badge, never "Active".
- Binding write tools must match the `mcp:write:<tool>` grammar (`write_tool_name_invalid`,
  #1940), so a write tool that can never be granted is not stored.

### Consequences

- 🟢 **Good:** No binding is overwritten by accident.
- 🟢 **Good:** The pane names the real reason a binding reaches nothing.
- 🔴 **Bad:** A script that relied on the upsert has to send `replace: true`.
- ⚪ **Neutral:** Deleting a key still leaves its binding; it is shown as `key_id_unknown` and
  reaches nothing. Cascading the delete is a follow-up.

## Pros and Cons of the Options

### A — 409 unless `replace: true`

- 🟢 Destructive case refused up front; one flag.
- 🔴 Breaking for blind upsert callers.

### B — Keep the upsert, report afterwards

- 🟢 No contract change.
- 🔴 The binding is already gone when the operator learns about it.

### C — Separate create and update routes

- 🟢 Clean REST semantics.
- 🔴 Larger change to the router and the pane for the same protection.

## More Information

`middleware/src/routes/publicMcpBindingsRouter.ts`, `middleware/src/index.ts` (`keyStates`),
`web-ui/app/admin/mcp/page.tsx` (`BindingsPane`), tests in
`middleware/test/publicMcp/publicMcpKeyBindingsAdmin.test.ts` and
`web-ui/app/admin/mcp/__tests__/bindingsWarnings.test.tsx`.
