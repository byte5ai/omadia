# 0273 — A deleted API key takes its public MCP binding with it

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (Welle 6, W33; decided after the recheck recommendation, reversible)
- **Supersedes:** — (completes [ADR-0213](0213-public-mcp-binding-replace-needs-explicit-consent.md) "dead keys are named")

## Context and Problem Statement

API keys live in `@omadia/channel-api`'s vault namespace; their public MCP bindings live in
Postgres (`public_mcp_key_bindings`), so no foreign key can cascade. Deleting a key left its
binding behind, shown as `key_id_unknown` forever (#2310). The plugin owns the delete route; the
kernel owns the bindings. Cascade the delete, or block it while a binding exists?

## Decision Drivers

- A binding of a deleted key grants nothing (the endpoint verifies the key first), so it is only
  clutter, but it reads like a typo.
- Deleting a key already needs a revoke first (`409 key_active`); a second blocker adds a step
  without protecting anything.
- A plugin-facing service must not let a plugin remove another key's binding.

## Considered Options

- **A — Cascade through a kernel service.** The kernel publishes `publicMcpKeyBindings`
  (`forgetDeletedKey(keyId)`); channel-api calls it after a delete.
- **B — Block the delete** while a binding exists (channel-api asks the kernel first).
- **C — Prune lazily** when the binding list is read.

## Decision Outcome

Chosen option: **A**.

- `createPublicMcpKeyBindingCascade` (`src/mcp/publicMcpKeyBindingCascade.ts`) removes a binding
  only when the vault holds no key with that id (revoked and expired keys still count as held).
  A vault read failure or a missing database keeps the binding (`unavailable`).
- channel-api declares `optional_requires: publicMcpKeyBindings@1` (0.1.1) and calls the service
  from its `DELETE /admin/keys/:id` after the delete succeeded. A failure is logged; the delete
  stands. An older kernel without the service leaves the binding, as before.
- Bindings of keys deleted before this change stay and keep their `key_id_unknown` warning; the
  operator removes them in the Bindings tab.

### Consequences

- 🟢 **Good:** no dead bindings from new deletes; one step for the operator.
- 🟢 **Good:** the service can only remove orphans, whatever plugin calls it.
- 🔴 **Bad:** a binding is gone with its key; re-creating access needs a new key and a new binding.
  Accepted: a new key has a new id anyway.
- ⚪ **Neutral:** C was rejected because a stale vault read must never delete a live binding.

## Pros and Cons of the Options

### A — Cascade through a kernel service

- 🟢 Matches the existing `channelDirectoryRegistry` pattern.
- 🔴 One more kernel service.

### B — Block the delete

- 🟢 Nothing is removed implicitly.
- 🔴 Two blockers in a row for a binding that grants nothing.

### C — Prune lazily

- 🟢 No plugin change.
- 🔴 Cannot tell a deleted key from an unreadable vault reliably at list time.

## More Information

- Tests: `middleware/test/publicMcp/publicMcpKeyBindingCascade.test.ts`
