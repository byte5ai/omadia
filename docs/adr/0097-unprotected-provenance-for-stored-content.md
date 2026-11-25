# 0097 — Content stored without a shield is stamped `unprotected` and kept out of shielded turns

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  issues #1507, #1534, #1536, #1540; PRs #1516, #1539, #1587 / #1592.
- **Supersedes:** —

## Context and Problem Statement

Recalled context is masked on its way to a model, but only where a detector sees something
([ADR-0095](0095-prompt-masking-wire-substitution-fail-closed.md)): e-mail addresses always, names only
with the optional C1 detector. A turn that ran without a shield, or in which a tool
bypassed it, puts names on record that no shield ever handled. Recall would hand them to a
later, shielded turn's model. The agent's own tools (`memory`, stored processes) are
intern-exempt, so what they return reaches the model as stored.

How does a shielded turn avoid reading content that was written outside the shield? This
record is retroactive.

## Decision Drivers

- Masking on the way out only catches detector-visible spans.
- Provenance is known at write time and cheap to record.
- Installing a shield later must not silently expose earlier unshielded content.
- Conversation continuity inside one chat matters to users.

## Considered Options

- **A — Stamp provenance at write time; every reader under a privacy handle excludes
  stamped content; derived content inherits the stamp.**
- **B — Mask recalled content harder on read.**
- **C — Purge unshielded content when a shield is installed.**

## Decision Outcome

Chosen option: **A**. Unknown provenance counts as unprotected (no turn context reads as
unprotected).

- **Turns.** The session log stores a Turn `unprotected` when it had no privacy handle or
  `hasBypassed()` is true; a subscription-CLI turn always. Every turn search under a shield
  passes `excludeUnprotected` (#1507).
- **Derived memory.** A `MemorableKnowledge` stamped `unprotected` or linked `DERIVED_FROM`
  an unprotected Turn is skipped by the memory, excerpt and durable recall legs; a plan
  whose Turn is unknown is dropped (#1536).
- **Notes.** A note the `memory` tool writes in an unprotected turn carries the line
  `<!-- omadia:unprotected -->` (`noteProvenance.ts`); the namespacers refuse it to a turn
  with a handle. Delete, rename and overwrite still work.
- **Processes.** `processes.unprotected` is set by `write_process` / `edit_process` and is
  never cleared by an edit; shielded turns skip or refuse such a process.
- **Whole trees.** Under a shield, or with `OMADIA_PRIVACY_FORCE_GUARDED` on, the
  namespacers refuse `/memories/sessions/` (transcripts hold restored real values, #1534)
  and a plugin's `ctx.memory` tree for every operation (`SHIELDED_SEGMENTS`,
  `SHIELDED_PHYSICAL`).
- **Plugin graph reads.** `ctx.knowledgeGraph.getNeighbors` under a handle keeps reference
  nodes and provably protected nodes and drops every other derived node.
- **Legacy content.** `scripts/backfill-unprotected-provenance.ts` marks only the items
  the detectors flag: C0 identity shapes, and a C1 span that looks like a personal name
  (two or more capitalised words at confidence 0.9 or more). It is a dry run unless
  `--apply`, refuses `--apply` without a C1 URL unless `--c0-only`, and aborts on a
  detector failure. Unflagged legacy items stay protected.

### Consequences

- 🟢 **Good:** A shielded turn's model never reads a transcript, note, memory or process
  that was written outside the shield.
- 🔴 **Bad:** On an instance that ran without a shield, installing one drops the whole
  earlier history from cross-session recall and stamps out promoted rules.
- 🔴 **Bad:** The marker covers a whole note; one edit from an unshielded turn hides a
  shared note from every shielded turn.
- 🔴 **Bad (accepted residuals):** the same chat's tail and briefing keep unprotected
  turns; a protected turn is protected against tool results, not against what the user
  typed with `mask_user_prompt` off; names in legacy content that C1 misses stay
  recallable; a directory listing still shows file names
  (`docs/security-architecture.md` §6f, "Accepted with notes").
- ⚪ **Neutral:** Every new store that a model can read back needs the stamp and the
  reader check.

## Pros and Cons of the Options

### A — Stamp and exclude

- 🟢 Deterministic; does not depend on detector recall.
- 🔴 Coarse: content is hidden whole, including harmless parts.

### B — Mask harder on read

- 🟢 Keeps history usable.
- 🔴 Only as good as the detector; names without C1 pass.

### C — Purge

- 🟢 Nothing left to leak.
- 🔴 Destroys data the operator may need; unshielded turns keep occurring (bypass, CLI).

## More Information

- Related: [ADR-0033](0033-memory-tool-protected-trees-and-seeded-rules.md),
  [ADR-0040](0040-one-graph-read-boundary-per-turn.md),
  [ADR-0092](0092-privacy-postures-bypass-and-org-clamp.md).
- Code: `middleware/packages/harness-orchestrator/src/orchestratorMemoryNamespacer.ts`,
  `middleware/packages/harness-orchestrator-extras/src/noteProvenance.ts`,
  `middleware/packages/plugin-api/src/knowledgeGraph.ts` (`excludeUnprotected`),
  `middleware/packages/harness-knowledge-graph-neon/src/migrations/0035_process_unprotected.sql`,
  `middleware/scripts/backfill-unprotected-provenance.ts`.
- Tests: `middleware/test/recallUnprotectedTurns1507.test.ts`,
  `recallDerivedUnprotected1536.test.ts` (+ `.pg`), `processProvenance1540.pg.test.ts`,
  `provenanceBackfill1540.pg.test.ts`.
