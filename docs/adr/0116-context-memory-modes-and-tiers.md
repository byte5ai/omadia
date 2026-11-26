# 0116 — Context memory: one memory stack per chat context, four per-agent modes, fail-closed

## Status

Accepted — refined by [ADR-0182](0182-web-and-api-turns-carry-an-account-or-key-origin.md) (web chat, web routines and Public API turns carry an
origin, so they are no longer context-free)

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); epic #860 with design spec #870,
  implemented in #881 (`off`, `enforce`, `enforce-strict`), #1340 (`members`) and #2138 (default
  `members` for new agents).
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. An agent used to get one memory stack at build time. What it noted
in Teams team A landed in one agent-wide tree and was quotable in team B on the next turn.
Later records build on the fix without stating it:
[ADR-0033](0033-memory-tool-protected-trees-and-seeded-rules.md) (protected trees),
[ADR-0040](0040-one-graph-read-boundary-per-turn.md) (graph read boundary) and ADR-0019 (default
mode). How is an agent's memory partitioned by chat context, and what happens when the context
is not known?

## Decision Drivers

- No flag day: existing agents must not change behaviour when the code lands.
- The context of a turn comes from a channel plugin, which is versioned independently and must
  not be able to widen a scope.
- An unknown context must never read as "everything".
- Sharing knowledge across contexts has to stay possible, deliberately.

## Considered Options

- **A — A per-turn binder that builds the memory stack from the turn's origin, a per-agent
  mode column, context tiers in a separate top-level tree.**
- **B — One agent-wide tree with per-file owner metadata**, filtered on read.
- **C — One agent per context** (separate agents for separate teams).

## Decision Outcome

Chosen option: **A**.

- **Mode per agent.** `agents.context_memory` (migrations 0050, 0062, 0099):
  `off` (one agent-wide stack for every turn), `enforce` (a context turn writes its own tier
  and reads the agent tier read-only), `enforce-strict` (no agent tier at all), `members`
  (tree as `enforce-strict`; knowledge belongs to the people present when it was created).
  `NOT NULL` with a default, so a NULL can never be read as a mode. New agents default to
  `members` since 0099; existing agents were not switched.
- **Binder.** `MemoryBinder.forOrigin` derives axes from the `TurnOrigin`
  (`memoryAxesForOrigin`, channel SDK), compiles the scope (`effectiveMemoryScope`) and builds
  `ContextMemoryNamespacer(ScopedMemoryStore(scope, root))`. It is synchronous and handed
  through the turn state, not async-local storage. Stacks are cached in an LRU
  (`DEFAULT_BINDER_CACHE_CAP = 256`); eviction drops a wrapper, never data.
- **Fail-closed.** No origin, a machine scope or an unresolvable one yields exactly
  `['core', 'orchestrator:<slug>:*']`. A malformed `axes` degrades to that scope and logs; it
  never throws on the message path and never widens. `off` is a routing decision in the binder,
  not a second branch in the scope resolver.
- **Tiers live in their own tree.** `team:` / `channel:` / `user:` grants map to
  `/memories/contexts/<slug>/<axis>/<ctxKey>/`, not under `/memories/orchestrators/<slug>/`,
  because the agent pattern `orchestrator:<slug>:*` would otherwise match every context tree.
  Keys never contain `:`.
- **Allowlist at the package boundary.** Only the three tier patterns are accepted from a
  channel plugin's axes; anything else (`core`, another agent's tree, `/memories/*`) is dropped
  and logged.
- **`members` tiers.** `MemoryBinder.forAudience` gives the room's owner set one writable tier
  and larger owner sets that include everyone present read-only tiers (`/memories/~g-<key>/`).
  Owner lists live in `members-index/`, outside every grant. An unknown room gets no tier; a
  binder failure leaves the turn without a memory tool.
- **Transcripts stay shared** under `/memories/sessions` (decision A3a in the binder); a
  context turn holds `ro:core-notes`, so it cannot read them.
- **Crossing a tier is an operator act.** `promoteMemory` (`services/memoryPromote.ts`) copies
  or moves notes between tiers of one agent, never across agents, and records it three ways: a
  JSONL line under `/memories/core/audit/`, provenance frontmatter in the file, a
  `[security-audit]` log line.

### Consequences

- 🟢 **Good:** A note from one room is not readable in another; the default for new agents is
  the strictest audience rule.
- 🟢 **Good:** The binder owns the whole decorator chain, so there is one place to reason about.
- 🔴 **Bad:** Agents created before 0099 stay `off` until an operator switches them, and
  switching hides the notes they wrote before (they are in the agent tier).
- 🔴 **Bad:** Only turns that carry a `TurnOrigin` are context-bound; web and API turns are
  context-free.
- 🔴 **Bad:** Four modes multiply every read path's test matrix (see ADR-0039).
- ⚪ **Neutral:** The audience of a room is a security input; a channel that marks its roster
  complete must refresh it on membership events (`docs/security-architecture.md`).

## Pros and Cons of the Options

### A — Binder, mode column, separate tier tree

- 🟢 Path-based, backend-agnostic, dark-launchable.
- 🔴 Layout rules ("do not tidy the two trees together") are conventions a refactor can break.

### B — Owner metadata per file

- 🟢 One tree.
- 🔴 The store has no metadata per file ([ADR-0123](0123-scratch-memory-is-a-virtual-file-tree.md)); every
  read path would filter itself.

### C — One agent per context

- 🟢 Uses the isolation agents already have.
- 🔴 Operators would maintain copies of one agent; no shared agent tier.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/memoryBinder.ts`,
  `registry/scopedMemoryStore.ts`, `orchestratorMemoryNamespacer.ts`, `membersMemory.ts`;
  `middleware/src/services/memoryPromote.ts`; `middleware/migrations/0050_…`, `0062_…`, `0099_…`.
- Tests: `memoryContextIsolation.test.ts`, `memoryBinder.cache.test.ts`,
  `memoryContextKey.test.ts`, `memoryPromote.test.ts`, `middleware/test/memoryAccess/`.
- Docs: `docs/security-architecture.md`, "Context memory: what a turn may recall".
- Related: ADR-0016, ADR-0019, ADR-0033, ADR-0039, ADR-0040. Border: agent runtime/orchestrator.
