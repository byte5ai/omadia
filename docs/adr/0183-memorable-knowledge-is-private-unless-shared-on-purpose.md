# 0183 — Memorable knowledge is private unless shared on purpose

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner decision of 2026-11-24 ("private knowledge always stays private",
  ADR-0040), applied by recommendation in #1823 (wave 5, W01); reversible.
- **Supersedes:** —

## Context and Problem Statement

`createMemorableKnowledge` left `visibility` to the column default `team` whenever a caller
passed none, which was every caller but the durable-rules hook: "Save as memory", automatic
promotion from turns, MCP ingestion, and the scratch reaper before #2141. Recall's team branch
(`teamVisibility`, on by default) admits `team` rows tenant-wide without checking owners or
the origin agent. Every saved or learned entry therefore reached every account and every agent,
while `/memories`, the memory API and the owner functions treat entries as owner-only. Which
default applies, and how does knowledge become shared?

## Decision Drivers

- Private knowledge always stays private; sharing is a deliberate act (ADR-0019, ADR-0040).
- Operator durable rules (`system:rules-hook`) are meant for everyone and must keep working.
- The plugin-api contract already documented "omitted → private".

## Considered Options

- **A — Default `private` at creation, migrate defaulted `team` rows, keep the recall team
  branch for rows shared on purpose.**
- **B — Turn `teamVisibility` off by default** and leave the stored values.
- **C — Keep `team` and document tenant-wide sharing** (the issue's option B).

## Decision Outcome

Chosen option: **A**.

- **Creation.** Both graph backends store `private` when `visibility` is omitted. Only callers
  that share on purpose pass `team` / `public` (today: durable rules).
- **Save as memory.** `POST /api/v1/memory` writes `private` and stamps `originAgent` from the
  agent of its source turn (one agent only), so per-agent recall isolation and the agent purge
  cover it.
- **Migration** `harness-knowledge-graph-neon` `0037`: every `MemorableKnowledge` row whose
  visibility is `team` or empty becomes `private`, except durable rules (`created_by =
  'system:rules-hook'`) and rows without owners (scratch-reaper output from before #2141; a
  private row nobody owns would be unreachable). `public` rows stay.
- **Recall.** `teamVisibility` stays on: after the migration its branch admits only knowledge
  shared on purpose. Option B was rejected because it would also hide durable rules from
  everyone but their (empty) owner list.

### Consequences

- 🟢 **Good:** Account B no longer recalls A's saved, promoted or MCP-ingested entries; a second
  agent no longer recalls entries stamped with the first agent; removing an owner removes recall.
- 🔴 **Bad:** A saved memory without a source turn of exactly one agent gets no `originAgent`
  and is recalled by every agent of its owner (still only for the owner).
- 🔴 **Bad:** Owner-less `team` rows from the old scratch reaper stay shared tenant-wide.
- 🔴 **Bad:** A `team` row an operator set by hand cannot be told apart from a defaulted one and
  becomes private; re-share it deliberately.
- ⚪ **Neutral:** No operator surface sets `visibility` yet; sharing other than durable rules is
  a follow-up.

## Pros and Cons of the Options

### A — Private default plus migration

- 🟢 Matches the documented contract and the owner model of `/memories`.
- 🔴 One-time data change.

### B — Recall owner-only

- 🟢 No data change.
- 🔴 Durable rules stop reaching anyone; stored values keep contradicting the UI.

### C — Shared by design

- 🟢 No change.
- 🔴 Contradicts the owner decision of 2026-11-24.

## More Information

- Code: `createMemorableKnowledge` in `harness-knowledge-graph-neon` / `-inmemory`,
  `middleware/src/routes/memory.ts`, migration
  `harness-knowledge-graph-neon/src/migrations/0037_memorable_knowledge_private_by_default.sql`.
- Related: ADR-0019, ADR-0040, ADR-0116, [ADR-0181](0181-a-new-memory-belongs-to-its-saver.md).
