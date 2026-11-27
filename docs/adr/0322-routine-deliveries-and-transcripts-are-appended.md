# 0322 — Routine deliveries and transcript turns are appended, not written back whole

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W43; #1753 rest; decision after recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

A routine that runs every 15 minutes writes into two growing files on every run (#1753): its
delivery is appended to the web chat document (`/memories/chat-sessions/<id>.json`, one JSON
document), and the turn is appended to the day's transcript (`/memories/sessions/<scope>/<day>.md`).
Both were read whole and written back whole; the cost of each run grew with the file. The
`MemoryStore` contract (plugin-api) had no way to append. Wave 6 (W34) left the choice open:
an append primitive in the contract, or a per-message storage layout.

## Decision Drivers

- The per-run cost must not grow with the file.
- No break for the plugins and decorators that implement `MemoryStore`.
- The chat document stays one document for the web UI and every reader (`ChatSessionStore`).
- Deliveries keep their rules: server-owned, cleared by a reset, gone with the chat.

## Considered Options

- **A — An optional `appendFile` on `MemoryStore` plus a delivery journal next to the chat document**
- **B — A per-message layout for chats** (one file per message, the document as an index)
- **C — A mandatory `appendFile`** on every store and decorator

## Decision Outcome

Chosen option: **A**.

- `MemoryStore.appendFile?(path, content)` appends without reading and creates a missing file
  (plugin-api 1.113.0, additive). `appendToMemoryFile(store, path, content)` is the one caller
  helper: it uses `appendFile` when the store has it and falls back to read + write otherwise.
  Postgres appends in one statement (`content || $2`); the in-memory store likewise.
  `LabelledMemoryStore` and `ScopedMemoryStore` implement it with the same checks as their
  `writeFile`; every other decorator is served by the fallback.
- The `SessionLogger` appends each turn to the day's transcript and writes the header only when
  the file is new.
- A routine delivery into a web chat is one JSON line `{ message, at }` in
  `/memories/chat-sessions/<id>.deliveries.jsonl` (the document is checked for existence only).
  `ChatSessionStore.get` and `list` return the document with the journaled deliveries it does not
  hold yet (by message id; `at` bumps `updatedAt`). The next `save` — always under the session lock
  and from a `get` — writes the merged document and drops the journal; a reset therefore drops
  journaled deliveries, and `delete` removes the journal with the document.

### Consequences

- 🟢 **Good:** a run costs one append per file, independent of the file size.
- 🟢 **Good:** no plugin or decorator has to change; a store without `appendFile` behaves as before.
- 🔴 **Bad:** until the user's next turn or PUT, a chat's deliveries live in two files; a reader
  that bypasses `ChatSessionStore` and reads the `.json` directly misses them (none does today).
- 🔴 **Bad:** the Postgres row still grows; Postgres rewrites the row version on each append
  (MVCC), but nothing crosses the wire or the process.
- 🔴 **Bad (accepted):** the session lock is per process. With two middleware processes an append
  between another process's `get` and its `save` is lost, as a concurrent rewrite was before; an
  unlocked `get` racing a `save` can miss the journal once, and the next re-read heals it.
- 🔴 **Bad (accepted):** a delivery into a chat whose document is unparseable is journaled; the
  next client PUT overwrites the document and drops the journal with it (before, the delivery
  failed instead).
- ⚪ **Neutral:** a corrupt journal line is skipped with a warning, the other deliveries show.

## Pros and Cons of the Options

### A — optional append + journal

- 🟢 Additive contract change; the document format is unchanged.
- 🔴 Two files per chat between saves.

### B — per-message layout

- 🟢 Bounded write per message for every writer, not only deliveries.
- 🔴 Changes the stored format of every chat and every reader; a migration of all chats.

### C — mandatory `appendFile`

- 🟢 One code path.
- 🔴 A breaking plugin-api change (major) for every `MemoryStore` implementation.

## More Information

Issue #1753; `middleware/packages/plugin-api/src/pluginContext.ts` (`appendFile`,
`appendToMemoryFile`), `harness-memory{,-postgres}`, `harness-orchestrator/src/{chatSessionStore,
sessionLogger}.ts`, `discretion/labelledMemoryStore.ts`, `registry/scopedMemoryStore.ts`; tests
`middleware/test/routineDeliveryJournal.test.ts`, `memoryStoreConformance.ts`.
Related: [ADR-0244](0244-routine-deliveries-are-context-of-their-chat.md),
[ADR-0123](0123-scratch-memory-is-a-virtual-file-tree.md), [ADR-0049](0049-plugin-api-semver-snapshot-and-compat-core.md).
