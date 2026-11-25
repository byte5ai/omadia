# 0117 — Turn memory ages: decay score, HOT/WARM/COLD tiers and per-scope quotas

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); Palaia integration phases 1 and 4
  (OB-73). The code cites "palaia ADR-004" as the source of the defaults; that document is not
  in this repository.
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. Every finished turn becomes a `Turn` node in the knowledge graph
([ADR-0004](0004-knowledge-graph-as-memory-substrate.md)). Without housekeeping the graph grows
without bound, and recall ranks a months-old exchange next to yesterday's. What keeps turn
memory relevant and bounded, and what may be deleted without anyone asking?

## Decision Drivers

- Recall quality: old, unused turns should not compete with fresh or often-used ones.
- Cost: no write on the read path; no per-row round trips on a serverless database.
- Process knowledge and open tasks are worth more than chatter.
- Deletion must be bounded, predictable and configurable by the operator.

## Considered Options

- **A — Score-based decay with three tiers, access tracking flushed in batches, daily
  per-scope quotas.**
- **B — Fixed time-to-live per node.**
- **C — Keep everything**, rank by recency at query time only.

## Decision Outcome

Chosen option: **A**, in the Postgres graph provider only.

- **Columns on `graph_nodes`** (migration 0007): `entry_type` (`memory` | `process` | `task`),
  `tier` (`HOT` | `WARM` | `COLD`), `accessed_at`, `access_count`, `decay_score`,
  `task_status`, `significance`.
- **Decay sweep** (`decayJob.ts`, default every 60 minutes, pure SQL):
  `score = exp(-λ · age_days) · (1 + ln(1 + access_count))` with `age_days` since
  `COALESCE(accessed_at, created_at)` and λ = 0.05 per day. HOT→WARM at score < 0.5 and 7 idle
  days; WARM→COLD at score < 0.1 and 30 idle days.
- **COLD is kept but not recalled.** The embedding search (`searchTurnsByEmbedding`) reads HOT and
  WARM unless the caller sets `includeCold`.
- **Access tracking is batched.** Read paths call `AccessTracker.markAccessed`; the sweep
  flushes one `UPDATE` per tick. A COLD turn that was accessed is promoted to WARM in that
  flush; the decay job only rotates down.
- **Done tasks are deleted.** A turn with `entry_type='task'` and `task_status='done'` is
  hard-deleted 24 hours after its last access.
- **Quota sweep** (`gc.ts`, default daily at 04:00 UTC): per scope at most 50 turns
  (`graph_gc_hot_max_entries`) and 500,000 characters (`graph_gc_max_total_chars`). Eviction
  order: tail-only turns first (#1096), then `type_weight × decay_score` ascending with weights
  process 2.0, task 1.5, memory 1.0.
- **Operator surface.** All thresholds are setup fields of `@omadia/knowledge-graph-neon`;
  `graph_decay_enabled` and `graph_gc_enabled` switch the jobs off. `graphLifecycle@1` backs
  `/api/v1/admin/kg-lifecycle/*` (tier histogram, manual sweeps). Jobs run single-flight
  (`overlap: 'skip'`).

### Consequences

- 🟢 **Good:** The graph stays bounded per conversation; recall favours used knowledge.
- 🟢 **Good:** Reads stay write-free; a sweep is one round trip for any number of rows.
- 🔴 **Bad:** Turns are deleted automatically, by default beyond 50 per scope. A long
  conversation loses its older turns from the graph; only the markdown transcript keeps them.
- 🔴 **Bad:** `getSession` marks every turn it returns as accessed, so scores in one session
  tie and eviction falls back to oldest first.
- 🔴 **Bad:** Access counts held in process memory are lost on a restart before the flush.
- ⚪ **Neutral:** The in-memory graph has no lifecycle. Quotas are per scope, not per tenant
  or per user.

## Pros and Cons of the Options

### A — Decay, tiers, quotas

- 🟢 Usage decides what stays; tunable.
- 🔴 More than a dozen tuning values an operator has to understand; deletion is not obvious from a chat.

### B — Fixed TTL

- 🟢 Easy to explain.
- 🔴 Deletes knowledge that is still used; keeps noise until its date.

### C — Keep everything

- 🟢 Nothing is lost.
- 🔴 Unbounded storage and index growth; old turns compete in every ranking.

## More Information

- Code: `middleware/packages/harness-knowledge-graph-neon/src/{decayJob,gc,accessTracker,
  lifecycleService}.ts`, `manifest.yaml` (`graph_decay_*`, `graph_gc_*`),
  `migrations/0007_palaia_schema_uplift.sql`; `SearchTurnsByEmbeddingOptions.includeCold` in
  `plugin-api/src/knowledgeGraph.ts`.
- Tests: `middleware/test/{decayJob,gc,accessTracker}.test.ts`.
- Related: ADR-0004, [ADR-0120](0120-memory-purge-is-complete-previewed-and-audited.md) (deletion on request),
  [ADR-0123](0123-scratch-memory-is-a-virtual-file-tree.md) (transcripts are not touched by these jobs).
