# 0118 — One generic node and edge table for the graph; bulk and structured data go to sidecar tables

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); initial graph schema (v0.1.0),
  process memory (Palaia phase 7, OB-76, "Variante A"), datasets in #430.
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive and refines
[ADR-0004](0004-knowledge-graph-as-memory-substrate.md), which chose a graph over Postgres but
not its shape. New kinds of knowledge keep arriving (sessions, turns, entities, runs, plans,
facts, curated memories, topics). Some data is not graph-shaped at all: a CSV with ten thousand
rows, a versioned process, token usage. How is the graph modelled so that a new node kind costs
no migration, and what must not become a node?

## Decision Drivers

- A new node or edge kind should not need DDL.
- Tenant and conversation filters must be a `WHERE` clause from day one.
- Node properties are GIN-indexed; large or numerous property bags make every write expensive.
- Row-level data needs filters and aggregates the graph interface does not offer.

## Considered Options

- **A — Generic `graph_nodes` / `graph_edges` tables with a text type discriminator; separate
  relational tables for bulk or structured data, linked by one node.**
- **B — One table per node kind.**
- **C — Everything as nodes**, including each data row.

## Decision Outcome

Chosen option: **A**.

- **Two generic tables** (migration 0001). `graph_nodes (external_id, type, tenant_id, scope,
  properties JSONB, embedding, …)` with `UNIQUE (tenant_id, external_id)`; `graph_edges (type,
  from_node, to_node, tenant_id, properties)` with `ON DELETE CASCADE` and
  `UNIQUE (tenant_id, from_node, to_node, type)`.
- **Type is text, validated in code.** A new kind (for example `MemorableKnowledge`,
  migration 0017) adds a value to the validator in `schema.ts` and, where needed, a partial
  index `WHERE type = '…'`; no column or table.
- **Ids are deterministic** (`session:<scope>`, `turn:<scope>:<iso timestamp>`,
  `<system>:<model>:<external id>`), so ingest is an upsert and a backfill is repeatable.
- **Tenant and scope are columns.** `tenant_id` defaults to `'default'` and comes from the
  provider's `graph_tenant_id`; `scope` is the conversation. All tenants share the physical
  tables.
- **Access attributes ride on the node.** `visibility` (`private` | `team` | `public` |
  `shared:<x>`, default `team`) as a column; owners of curated memory as
  `properties->'acl_owners'` with a GIN index (migration 0018). Owner changes are logged in
  `memory_acl_audit`, which has no foreign key so the trail outlives the memory.
- **Sidecar tables instead of node explosion.**
  - *Datasets* (#430): `datasets` + `dataset_rows` (JSONB per row, GIN index). Exactly one
    `PluginEntity` node (`system='dataset'`) per dataset for recall and citation; rows are
    never nodes. Queried through the `query_dataset` tool's filter and aggregate DSL, never
    raw SQL from the model.
  - *Processes*: own table `processes` with deterministic id
    `process:<scope>:<slug(title)>`, a title convention enforced by a `CHECK`, an embedding
    for dedup-first writes (`process_dedup_threshold`, default 0.9) and append-only
    `process_history`.
  - Verifier tables, token usage, Teams attachment and conversation references live in the
    same series and pool as plain tables.
- **Both backends implement the sidecars** (datasets with full parity in the in-memory graph).

### Consequences

- 🟢 **Good:** New knowledge kinds ship without schema changes; one read path filters all of
  them by tenant, scope and type.
- 🟢 **Good:** Row data keeps relational filters and stays out of the property index.
- 🔴 **Bad:** The database enforces little about a node's shape; a wrong `properties` layout is
  caught only by the validator or by a query that finds nothing.
- 🔴 **Bad:** Table-wide operations hit all tenants (see
  [ADR-0121](0121-one-embedding-model-per-vector-space.md)).
- 🔴 **Bad:** The knowledge-graph migration series has become the home of tables that are not
  graph (token usage, verifier tables, Teams references); their schema exists only where the
  Postgres graph provider has activated.
- ⚪ **Neutral:** Access checks for a sidecar are its own (a dataset has
  `owner_omadia_user_id`); the node filter of
  [ADR-0040](0040-one-graph-read-boundary-per-turn.md) covers only the linking node.

## Pros and Cons of the Options

### A — Generic tables plus sidecars

- 🟢 Flexible where kinds change, relational where rows matter.
- 🔴 Two modelling styles; the rule which one applies is a convention.

### B — Table per kind

- 🟢 Typed columns and constraints.
- 🔴 A migration per kind; walks across kinds become unions.

### C — Everything a node

- 🟢 One interface.
- 🔴 A 10,000-row import becomes 10,000 GIN-indexed nodes; aggregates need application code.

## More Information

- Code: `middleware/packages/harness-knowledge-graph-neon/src/migrations/{0001_graph_init,
  0007_palaia_schema_uplift,0009_process_memory,0017_memorable_knowledge,0018_acl_owners,
  0029_datasets}.sql`, `src/schema.ts`, `src/processMemoryStore.ts`;
  `middleware/packages/plugin-api/src/knowledgeGraph.ts`; `docs/middleware-agent-handoff.md` §7.
- Tests: `datasetsRoute.test.ts`, `queryDatasetTool.test.ts`, `datasetImport.test.ts`,
  `inMemoryKnowledgeGraph.test.ts`.
- Related: ADR-0004, ADR-0040, [ADR-0124](0124-storage-capabilities-ship-as-sibling-providers.md).
