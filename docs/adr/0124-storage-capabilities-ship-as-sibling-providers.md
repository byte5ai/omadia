# 0124 — Storage capabilities ship as two sibling providers; bootstrap installs exactly one

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); knowledge-graph
  split in roadmap step S+11-2b, Postgres memory store in #269, memory backend selection OM-87.
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive: it documents what main already does.
[ADR-0004](0004-knowledge-graph-as-memory-substrate.md) puts agent memory on Postgres with a
vector extension and [ADR-0003](0003-capability-based-multi-provider-middleware.md) makes every
store a capability. But a demo, a CI run and a first local start have no Postgres, and the
kernel treats both `knowledgeGraph@1` and `memoryStore@1` as required. How does an install
without a database get both stores, and how is the choice between a durable and a volatile
store made and kept?

## Decision Drivers

- The middleware must boot and answer a chat without any database.
- Production state must survive a restart and be shared by several instances.
- Two active providers of one store would split the data silently.
- Tests need a backend that runs without a DSN and still means something for production.

## Considered Options

- **A — Two sibling provider plugins per storage capability (Postgres and in-process), one
  installed by bootstrap.**
- **B — One provider per capability with an internal backend switch.**
- **C — Require Postgres everywhere** (embedded Postgres for demos and CI).

## Decision Outcome

Chosen option: **A**.

- **Siblings.** `knowledgeGraph@1` is provided by `@omadia/knowledge-graph-neon`
  (`harness-knowledge-graph-neon`) and `@omadia/knowledge-graph-inmemory`; `memoryStore@1` by
  `@omadia/memory-postgres` and `@omadia/memory` (`InMemoryMemoryStore`, process RAM). There is
  no filesystem memory store any more.
- **Mutual exclusion is structural.** Both siblings declare the same `provides:`;
  `ctx.services.provide` throws on a second registration.
- **Bootstrap is the only installer.** `bootstrapKnowledgeGraphFromEnv` installs the Neon
  provider when `DATABASE_URL` is set, else the in-memory one. `bootstrapMemoryFromEnv` resolves
  the backend as: persisted operator choice (`memory_backend`) → `MEMORY_BACKEND` → derived from
  `DATABASE_URL`; it removes the non-selected sibling. Postgres memory without `DATABASE_URL`
  falls back to in-memory. The built-in catch-all installer skips all four ids.
- **No automatic flip for the graph.** Once a graph provider is installed it stays, whatever
  the env says later; switching is an operator act in the install UI.
- **One pool.** The Neon graph plugin opens the pool and publishes it as `graphPool@1`; the
  Postgres memory store `requires: graphPool@^1` and never opens or ends a pool of its own.
- **Same contract, stated honestly.** The in-memory siblings implement the full interface
  (datasets included, "no stub"), with no embeddings and no persistence. Capabilities only
  Postgres can back (`graphPool@1`, `graphLifecycle@1`, `agentPriorities@1`, `processMemory@1`)
  are provided by the Neon plugin alone. Shared suites pin the parity:
  `memoryStoreConformance.ts` and the memory-access contract of
  [ADR-0039](0039-memory-access-verified-by-oracle-and-canary-sweep.md) run on both backends.
- **A missing DSN publishes nothing.** The Neon plugin without `database_url` returns a no-op
  handle; it does not degrade to RAM by itself.

### Consequences

- 🟢 **Good:** An empty install boots; production gets durable, shared stores from the same
  contract.
- 🟢 **Good:** Access rules are tested on a backend that needs no database and on the real one.
- 🔴 **Bad:** Every interface change is implemented twice (`neonKnowledgeGraph.ts` and
  `inMemoryKnowledgeGraph.ts` are 5,956 and 3,748 lines).
- 🔴 **Bad:** On the in-memory siblings all notes, transcripts and graph nodes are gone after a
  restart, and nothing in a chat tells the user.
- 🔴 **Bad:** The Postgres memory store depends on the graph plugin for its pool; a failed graph
  activation takes scratch memory with it.
- ⚪ **Neutral:** The two selections differ: memory re-resolves and swaps on every boot, the
  graph does not. Service and package names still carry `neon` although any Postgres with
  pgvector works.

## Pros and Cons of the Options

### A — Sibling providers, one installed

- 🟢 No backend branch inside a store; the resolver enforces the exclusion.
- 🔴 Twice the implementation and two packages per capability.

### B — One provider with a backend switch

- 🟢 One package, one manifest.
- 🔴 A Postgres dependency and its setup fields in the demo path; the switch becomes runtime
  state inside the store.

### C — Postgres everywhere

- 🟢 One implementation.
- 🔴 No database-free boot or unit test; heavier CI and first start.

## More Information

- Code: `middleware/src/plugins/bootstrap.ts` (`bootstrapMemoryFromEnv`, `resolveMemoryBackend`,
  `bootstrapKnowledgeGraphFromEnv`), the four packages' `manifest.yaml` and `src/plugin.ts`.
- Tests: `middleware/test/memoryStoreConformance.{inmemory,pg}.test.ts`,
  `middleware/test/memoryAccess/aclContract*.test.ts`, `inMemoryKnowledgeGraph.test.ts`.
- Related: ADR-0003, ADR-0004, ADR-0039, [ADR-0123](0123-scratch-memory-is-a-virtual-file-tree.md),
  [ADR-0119](0119-independent-migration-series-per-subsystem.md).
