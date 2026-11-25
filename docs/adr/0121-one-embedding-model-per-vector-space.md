# 0121 — One embedding model per vector space: a gate at activation, destructive steps only on operator action

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); issue #440, PR #537; hardened in
  audit round 5 (OM-98).
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. The knowledge graph stores embeddings in `vector(n)` columns
(`graph_nodes.embedding`, `processes.embedding`;
[ADR-0004](0004-knowledge-graph-as-memory-substrate.md)). Since #440 the embedding provider is a
pluggable capability (`embeddingClient@1`). Vectors of two models in one column do not fail:
recall just gets worse. A provider with another dimension fails per row, which used to be
swallowed while the graph ran full-text only and reported healthy. What happens when the active
embedding model does not match what the database holds?

## Decision Drivers

- Silent degradation is worse than a visible block.
- Several instances run at once during a rolling deploy; two adapter versions must not wipe
  each other's work in turns.
- Re-embedding costs one provider call per row; discarding vectors must be a decision.
- `graph_nodes` and `processes` are single tables with a `tenant_id` column: a column rebuild
  hits every tenant.

## Considered Options

- **A — Record the model per tenant, check it and the declared column width at activation,
  block on a mismatch, clear or rebuild only under guards.**
- **B — Store the model per row** and filter by model at query time.
- **C — One vector column per model.**

## Decision Outcome

Chosen option: **A**.

- **Registry.** `graph_embedding_model` (migration 0030): one row per tenant with `model_id`,
  `dimensions`, `clear_pending`. One row per tenant is the single-active-model rule in schema.
- **Gate at activation** (`embeddingModelGate.ts`). First the declared width of every governed
  vector column, read from the catalog and not sampled from rows; then the recorded model.
  Width ≠ provider dimensions → `blocked/column-width-mismatch`. Matching column, no record →
  adopt the active model. Same dimensions, different model → clear all governed vectors and let
  the backfill re-embed. A registry row this instance did not expect → `registry-conflict`,
  blocked.
- **Blocked means full-text only, and visible.** Nothing is deleted; the status is published to
  `/health` and the admin page (`gateStatusPublication.ts`).
- **No vector writes while a clear is owed.** `allowsVectorWrites()` is false while
  `clear_pending` is true, so "a non-NULL vector is an old-model vector" holds by construction.
  The clear runs in bounded batches and is resumed by the backfill sweep.
- **Serialised.** Read–decide–flip is one transaction under `pg_advisory_xact_lock` with a
  compare-and-set on what was read. The clear and the column rebuild hold session-level locks
  (namespaces 4401 and 4400) on a direct connection (`connectForSession`,
  [ADR-0034](0034-no-session-state-behind-a-transaction-pooler.md)).
- **Cooldown.** A model switch is refused when the registry row is younger than
  `DEFAULT_SWITCH_COOLDOWN_MS` (10 minutes) and vectors exist.
- **A column rebuild never happens at startup.** `auto_migrate_vector_columns` (default
  `true`) only permits it. It is triggered by an operator action under Admin → Embedding
  provider: a provider switch with "Discard vectors", or "Reactivate provider" when all
  affected columns are empty (checked table-wide, under a table lock). `false` forbids both and
  requires a hand-written migration.
- **Backfill.** `embeddingBackfill.ts` re-embeds NULL rows in sweeps (defaults: every 5 minutes,
  20 rows, 5 attempts per row), each sweep a maintenance run of the model gateway.

### Consequences

- 🟢 **Good:** A wrong provider is a visible, reversible state instead of bad recall.
- 🟢 **Good:** A third vector column is covered without touching the gate (catalog discovery).
- 🔴 **Bad:** A provider switch discards every stored embedding, for all tenants of the
  database; re-embedding costs provider calls and takes many sweeps on a large corpus.
- 🔴 **Bad:** Until the backfill has caught up, semantic recall is partial.
- 🔴 **Bad:** The cooldown makes a mixed-adapter rolling deploy loud, not correct.
- ⚪ **Neutral:** A provider that reports no model metadata cannot be compared; the gate still
  honours an owed clear for it. The in-memory graph has no embeddings and no gate.

## Pros and Cons of the Options

### A — Registry, gate, guarded clear and rebuild

- 🟢 One cosine space per column, enforced.
- 🔴 About 3,000 lines of gate, clear and migration code with subtle locking.

### B — Model per row

- 🟢 No clear; old vectors stay usable for their model.
- 🔴 Different dimensions cannot share a `vector(n)` column; the HNSW index mixes spaces.

### C — Column per model

- 🟢 Switching back is free.
- 🔴 Schema grows with every model; storage and index cost multiply.

## More Information

- Code: `middleware/packages/harness-knowledge-graph-neon/src/{embeddingModelGate,
  staleVectorClear,vectorColumnMigration,vectorColumnCatalog,gateAutoMigration,gateReevaluation,
  gateStatusPublication,embeddingBackfill,sessionConnection}.ts`, `manifest.yaml`
  (`auto_migrate_vector_columns`), `migrations/0030_embedding_model_registry.sql`.
- Tests: `embeddingModelGate.test.ts`, `embeddingModelGate.pg.test.ts`,
  `embeddingModelGateMigration.pg.test.ts`, `embeddingModelGateMigrationGuards.pg.test.ts`,
  `vectorColumnMigrationLock.test.ts`.
- Docs: `docs/security-architecture.md` §10a (a tenant-scoped check may not authorise a
  table-wide statement).
- Related: ADR-0003, ADR-0004, ADR-0034. Border: embedding providers / model gateway.
