# 0120 — The memory purge deletes what its preview showed, and writes its audit row first

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); issues #1333–#1336.
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. The Danger-Zone purge (`/api/v1/admin/memory/purge`, page
`/admin/danger-zone`) is the operator's tool for erasure requests. Memory lives in two stores
(the `/memories` tree and the knowledge graph), and before #1333–#1336 a purge left
conversation history in the graph, could be sent without a preview, could wipe more than the
seed on a re-seed, and recorded its actor from the request body. What must a purge delete, how
is the operator shown it beforehand, and what is recorded?

## Decision Drivers

- An erasure tool that leaves the full user message in a `Turn` node does not erase.
- Preview and delete must not select by different rules.
- A destructive call must leave a record even when it fails halfway.
- A purge must never destroy data no selection named (chat tabs, brand assets, settings).

## Considered Options

- **A — One plan for preview and delete across both stores, a server-enforced single-use
  preview token, audit row before the first delete.**
- **B — Client-side confirmation only** (dialog, then `DELETE`), audit after success.
- **C — Soft delete with a retention window.**

## Decision Outcome

Chosen option: **A**.

- **Axes.** `all`, `agent`, `user`, `team`, `channel` (`MemoryPurgeAxis`). Every axis but
  `all` needs a selector (`selector_required`).
- **Scratch side.** Runs on the root store with `list` and `delete`. `axis: 'all'` keeps the
  protected top-level entries `_rules`, `_brand`, `core`, `sessions`, `chat-sessions` and
  `ui-prefs` (`PROTECTED_SEED_ENTRIES`); `/memories/contexts` is ordinary scratch and goes.
  The `user` axis with an omadia user id removes every `members` owner set that includes them.
- **Graph side.** A purge deletes `MemorableKnowledge` and the conversation history of its
  selection: `Turn`, `Session`, `Run`, `AgentInvocation`, `ToolCall`, `Plan`, `PlanStep` and
  the `Fact`s derived only from deleted turns. Agent axis = scopes `<slug>::…`; user axis =
  nodes whose `user_id` is the user's id or the AAD id of one of their channel identities, plus
  turns that `BELONGS_TO` their user cluster; a group `Session` stays while another speaker's
  turns remain.
- **One plan.** Preview and delete resolve the same plan (scratch targets plus graph filters,
  one shared CTE in the Neon backend). The delete re-resolves it when it runs; the audit row
  keeps the planned counts next to the deleted ones.
- **Preview is enforced by the server.** `POST /preview` returns a token bound to axis,
  selector and re-seed, single-use, valid `PREVIEW_TOKEN_TTL_MS` (10 minutes), held in process
  memory. A `DELETE` without a matching token gets `409 preview_required`.
- **Re-seed is narrow.** It lifts protection only for the entries the bundled seed directory
  (`MEMORY_SEED_DIR`) contains, today `_rules`, and writes them back at once.
- **Audit first.** The actor comes from the session (`auditActorFromRequest`). A
  `memory_purge_audit` row in state `started` and a `memory.purge` row in `admin_audit` are
  written in one transaction before anything is deleted; if that fails the purge is refused
  (`500 audit_write_failed`). Afterwards the row gets the counts and `completed` or `failed`.
  Without a Postgres pool responses carry the warning `audit_unavailable`.

### Consequences

- 🟢 **Good:** What the operator confirmed is what is selected; nothing can be purged blind.
- 🟢 **Good:** A failed purge is on record with the layers that finished.
- 🔴 **Bad (kept on purpose):** Transcripts under `/memories/sessions` and chat tabs under
  `/memories/chat-sessions` survive every purge, so the text of a purged user's turns can still
  exist there. This is an open point, not a decision that they are exempt from erasure.
- 🔴 **Bad:** Team and channel axes have no graph scoping; the response says so.
- 🔴 **Bad:** A user purge misses a turn whose `user_id` is a raw channel id when its run trace
  was never ingested.
- 🔴 **Bad:** The token does not survive a restart or span several middleware processes.
- ⚪ **Neutral:** The outcome lives only in `memory_purge_audit`, because `admin_audit` is
  append-only. On an in-memory install there is no audit store.

## Pros and Cons of the Options

### A — One plan, enforced preview, audit first

- 🟢 Complete, attributable, hard to trigger by accident or by script.
- 🔴 Process-local token; more moving parts per purge.

### B — Client confirmation, audit after

- 🟢 Simple.
- 🔴 Any API caller skips the preview; a crash mid-purge leaves no record.

### C — Soft delete

- 🟢 Reversible.
- 🔴 The data an erasure request names is still stored; every read path would need the filter.

## More Information

- Code: `middleware/src/routes/memoryPurge.ts`, `src/services/memoryPurge.ts`,
  `src/services/memoryPurgeAudit.ts`; `purge…` paths in
  `harness-knowledge-graph-neon/src/neonKnowledgeGraph.ts` and the in-memory sibling.
- Tests: `memoryPurge.test.ts`, `memoryPurgeRoute.test.ts`, `memoryPurgeRoute.pg.test.ts`,
  `memoryPurgeKg.pg.test.ts`.
- Docs: `docs/security-architecture.md` §10q "Danger-Zone memory purge".
- Related: [ADR-0033](0033-memory-tool-protected-trees-and-seeded-rules.md) (rules come from the
  seed), [ADR-0123](0123-scratch-memory-is-a-virtual-file-tree.md), [ADR-0116](0116-context-memory-modes-and-tiers.md).
