# 0033 — The memory tool protects shared trees by path; rules come only from the seed

## Status

Accepted

- **Date:** 2026-11-23
- **Deciders:** Maintainers, from issues #1827 and #1828 (security fast track of the issue
  sweep of 2026-11-23); PRs #2034, #2037, #2040 and #2216 (transcript trees). Option A for `_rules` was agreed on #1827.

## Context and Problem Statement

The memory tool works on a model-facing `/memories` tree. The namespacer maps it to the
agent's physical root (`/memories/orchestrators/<slug>`) and passes the shared trees
(`/memories/core`, `sessions`, `chat-sessions`, top-level `_*`) through unchanged.
`ScopedMemoryStore` grants each turn a set of patterns: a context-bound turn holds `ro:core`
(`ro:core-notes` under `enforce-strict`, so no transcript trees), a context-free turn holds
plain `core`. In context-memory mode "Off" (the default) every chat, Public API and channel
turn is context-free and holds `core`, which grants writes to `/memories/_*`.

Three gaps followed from that, all reachable from one chat turn or from injected text the
model read:

- `delete /memories` removed every note of the agent and every plugin's `ctx.memory` tree.
  The store's root guard compared against the physical `/memories` only (#1828).
- `delete /memories/core` or a rename of it took the operator promotion log
  (`/memories/core/audit/`) with it. The deny check looked only at the named path, and
  `/memories/core//audit/…` escaped it by spelling (#1827, part 1).
- A file written under `/memories/_rules/` became a rule for every agent and every account:
  the system prompt tells agents to read rule files, and `DurableRulesMemoryStore` copied
  each write into team-wide curated knowledge (#1827, part 2).

Which trees may an agent turn change, and where do rules come from?

## Decision Drivers

- ADR-0016: a chat turn holds no write grant on trees shared by every agent and account.
- ADR-0019: memory is written only into a tier whose readers may all know it. A tenant-wide
  rule from one chat breaks this.
- A directory delete or rename acts on every descendant, so a check on the named path alone
  is not a check.
- Seeding and operator paths (root store at boot, re-seed purge) must keep working.

## Considered Options

- **A — Deny list on canonical paths, structural guards in the namespacer, rules read-only
  for agents and maintained in the repo seed.**
- **B — Give every chat turn `ro:core` and read-only `_*`**, so only context-free kernel
  callers write shared trees.
- **C — Keep `_rules` writable, but promote a rule only from an operator or kernel caller.**

## Decision Outcome

Chosen option: **A**, because it closes all three gaps in the store and namespacer without
changing the grant model every turn already has.

- **Agent-unwritable prefixes.** `AGENT_UNWRITABLE_PREFIXES` in `ScopedMemoryStore` holds
  `/memories/core/audit/`, `/memories/_rules/`, `/memories/sessions/` and
  `/memories/chat-sessions/`. Create, write, delete and rename there are refused with
  `MemoryScopeViolation`; reading stays allowed.
- **Transcripts are kernel-written.** `SessionLogger` and `ChatSessionStore` write
  transcripts through the unscoped store (still wrapped in `LabelledMemoryStore` when
  discretion is on); no agent scope writes there, so `session:*` grants reads only (#2216).
- **Ancestors count.** `delete` and the `rename` source are refused when the path *contains*
  a protected prefix (`/memories`, `/memories/core`). Siblings under `/memories/core/` stay
  writable, deletable and renamable.
- **Canonical paths.** The check runs on the path as the stores resolve it: duplicate and
  trailing slashes collapsed.
- **Structural guard.** `MemoryNamespacerBase` refuses `delete` and `rename` of a bound root
  (`/memories`; `~team` and `~agent` in context turns) and anywhere in a plugin's storage tree,
  also as a rename target, with or without a Privacy Shield. The refusal is a
  `MemoryInvalidPathError`, so the model gets an ordinary `Error: …` result.
- **Rules come from the repo seed.** Only `MEMORY_SEED_DIR`, written on the root store at boot
  and on a re-seed purge, creates rules. The system prompt, the CLI memory conventions and the
  seed README say rules are read-only. `DurableRulesMemoryStore` no longer fires from chat;
  seeded rules reach the durable tier through `scripts/backfill-durable-rules.ts`.

### Consequences

- 🟢 **Good:** No turn can erase an agent's notes, a plugin's storage or the audit log, or
  plant a rule for every account.
- 🟢 **Good:** A new protected tree is one entry in the deny list; ancestors and spellings are
  covered by the same check.
- 🔴 **Bad:** Rules can no longer be added or corrected at runtime; changing one is a repo
  change and a re-seed.
- 🔴 **Bad:** Rules planted before the fix stay. They have no owner; cleaning them up depends
  on #1829 and #1831.
- ⚪ **Neutral:** Other `_*` trees (for example `_brand`) keep their grant. How rules are
  managed in future (admin page, per-user or per-agent rules) is open in discussion #2041.
  The `DurableRulesMemoryStore` hook is left in place; removing it is a separate decision.

## Pros and Cons of the Options

### A — Deny list, structural guards, seeded rules

- 🟢 Closes the reported paths and their spellings in one place per layer.
- 🔴 Leaves shared `core` notes writable from a context-free turn, by design.

### B — Read-only shared trees for every chat turn

- 🟢 Closes the class at the grant level.
- 🔴 Changes what every context-free turn may do, including operator and CLI turns that
  rely on writing `/memories/core` today; needs its own migration of habits and prompts.

### C — Writable `_rules`, operator-only promotion

- 🟢 Keeps runtime rule edits.
- 🔴 A planted file is still read as a rule through the system prompt's instruction, even if
  it is never promoted.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/registry/scopedMemoryStore.ts`,
  `orchestratorMemoryNamespacer.ts` (`MemoryNamespacerBase`).
- Tests: `memoryContextIsolation.test.ts`, `orchestratorMemoryNamespacer.test.ts`,
  `contextMemoryNamespacer.test.ts`.
- Related: ADR-0016, ADR-0019, [ADR-0040](0040-one-graph-read-boundary-per-turn.md) (read side).
