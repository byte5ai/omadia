# 0123 — Scratch memory is a virtual `/memories` file tree behind one store port

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); Postgres
  store in #269.
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. Besides the knowledge graph
([ADR-0004](0004-knowledge-graph-as-memory-substrate.md)) agents keep free-form notes through the
model's `memory` tool (`memory_20250818`), which speaks in file paths and file commands. The
kernel also needs a place for per-turn transcripts, web chat tabs, seeded rules and plugin
storage. What is the storage model behind that tool, and who writes which part of it?

## Decision Drivers

- The tool contract is a file tree; the store should not translate it into something else.
- The same code must run on RAM and on Postgres
  ([ADR-0124](0124-storage-capabilities-ship-as-sibling-providers.md)).
- Access control is by path ([ADR-0033](0033-memory-tool-protected-trees-and-seeded-rules.md)),
  so the physical layout is part of the security model.
- Operator tools (purge, promote) must work on any backend without new store methods.

## Considered Options

- **A — One virtual file tree behind a small `MemoryStore` port; physical layout fixed by
  convention; decorators add scope, namespace and labels.**
- **B — Typed tables per kind of content** (notes, transcripts, chat sessions, rules).
- **C — Notes as knowledge-graph nodes only**, no file tree.

## Decision Outcome

Chosen option: **A**.

- **The port.** `MemoryStore` (plugin-api): `list`, `fileExists`, `directoryExists`,
  `readFile`, `createFile`, `writeFile`, `delete`, `rename`. Text only. Every path starts with
  `/memories`.
- **Directories are implicit.** A directory exists while a file has it as a prefix; `list`
  walks two levels. The Postgres store is one table, `memory_files (virtual_path PRIMARY KEY,
  content, size_bytes, …)` with a `text_pattern_ops` prefix index.
- **Physical layout.**
  `/memories/orchestrators/<slug>/…` one agent's private tree (plugin storage under
  `…/plugins/<pluginId>/`); `/memories/contexts/<slug>/<axis>/<ctxKey>/…` chat-context tiers
  ([ADR-0116](0116-context-memory-modes-and-tiers.md)); `/memories/core`, `/memories/_rules`, `/memories/_brand`
  shared; `/memories/sessions/<scope>/YYYY-MM-DD.md` turn transcripts;
  `/memories/chat-sessions/<id>.json` web chat tabs; `/memories/ui-prefs` per-user settings.
- **The model never sees the physical tree.** A namespacer maps the model-facing `/memories`
  to the agent's root; `ScopedMemoryStore` filters by grant (reads outside the scope behave as
  absent, writes throw).
- **Transcripts are written by the kernel, in a parseable format.** `SessionLogger` appends
  each finished turn as markdown, then calls `knowledgeGraph.ingestTurn`. A failed markdown
  write suppresses the ingest; a failed ingest does not undo the transcript.
  `sessionTranscriptParser.ts` reads the same format back for `graphBackfill.ts`, so a renderer
  change must be mirrored in the parser. The heading carries milliseconds because turn ids are
  derived from it.
- **Seeding.** `MemorySeeder` copies `MEMORY_SEED_DIR` (default `./seed/memory`, today only
  `_rules/`) into the root store at activation. Mode `missing` (default) creates absent files,
  `overwrite` pins the repo version, `skip` does nothing.
- **Operator code uses the root store.** Purge and promote run on the undecorated store with
  `list` and `delete` only, so they work on both backends.

### Consequences

- 🟢 **Good:** The tool's commands map one to one; a new backend is eight methods and one
  conformance suite.
- 🟢 **Good:** Path-based grants, deny prefixes and purge axes all read the same layout.
- 🔴 **Bad:** No structure below the file: no per-note owner, no index over content; a
  transcript day is rewritten whole on each append (`previous + turn`).
- 🔴 **Bad:** Parser and renderer are coupled by convention; a mismatch makes the backfill
  skip turns without an error.
- 🔴 **Bad:** Seed mode `missing` never updates a rule that already exists; a changed seed file
  reaches an existing install only through `overwrite` or a re-seed purge
  ([ADR-0120](0120-memory-purge-is-complete-previewed-and-audited.md)).
- ⚪ **Neutral:** `docs/middleware-agent-handoff.md` §5 still names a `FilesystemMemoryStore`;
  no such class exists on main.

## Pros and Cons of the Options

### A — Virtual file tree behind a port

- 🟢 Smallest contract; backend-agnostic operator tools.
- 🔴 Weak typing; layout knowledge lives in several modules.

### B — Typed tables

- 🟢 Owners, timestamps and queries per kind.
- 🔴 The `memory` tool would need a translation layer; no RAM sibling for free.

### C — Graph nodes only

- 🟢 One store.
- 🔴 The model's file commands (`str_replace`, `rename`) have no graph meaning; node properties
  are meant to stay small ([ADR-0118](0118-graph-nodes-stay-small-bulk-data-in-sidecar-tables.md)).

## More Information

- Code: `middleware/packages/harness-memory/src/{inMemoryMemoryStore,memoryTool,seeder}.ts`,
  `harness-memory-postgres/src/postgresMemoryStore.ts`, `migrations/0001_memory_files.sql`,
  `harness-orchestrator/src/{sessionLogger,chatSessionStore,orchestratorMemoryNamespacer}.ts`,
  `harness-orchestrator-extras/src/{graphBackfill,sessionTranscriptParser}.ts`.
- Tests: `middleware/test/memoryStoreConformance.ts` (+ `.inmemory.test.ts`, `.pg.test.ts`).
- Related: ADR-0004, ADR-0033, ADR-0040.
