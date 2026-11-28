# 0296 — Stored text with an earlier turn's placeholder is withheld per entry

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** Wave lead (technical decision 2026-11-27, issue #2296), W31 cluster lead
- **Supersedes:** — (refines [ADR-0191](0191-memory-notes-restored-on-write-and-re-masked-on-read.md))

## Context and Problem Statement

ADR-0191 withholds a stored text that carries a placeholder the reading turn minted for another
value. #2296 extends the detection to reserved-shape placeholders of any earlier turn
(`PLATZHALTER-<TYPE>-<n>`, a pool name at `example.net`) and to stored processes. Applied to the
whole text, one old note would hide the whole prefetched `/memories` index for every turn, and
one old process every `query_processes` hit. What is the unit of withholding?

## Decision Drivers

- A stale placeholder must never be read as a fact about another value.
- One old entry must not take everything else with it.
- No extra cost on the common path.

## Considered Options

- **A — Whole text first; on a stale-placeholder refusal, mask per entry and leave out only the affected entries.**
- **B — Always per entry.**
- **C — Replace stale placeholders with "unknown" in place.**

## Decision Outcome

Chosen option: **A** (`maskStoredTextPerEntry`, `memoryNoteSurrogates.ts`).

- The whole text is masked as before. Only when it is refused for an earlier turn's placeholder
  is it split into entries: a `/memories` listing line by line, a `query_processes` result hit by
  hit. A cheap count per entry finds the affected ones; they are left out and counted
  (`(n entries withheld: placeholders from an earlier conversation)`); the rest is masked
  through the reading turn's map. One note or one process is one entry and is withheld whole.
- Used for the prefetched memory index and for `memory` and stored-process tool results in all
  dispatch seams (orchestrator, `LocalSubAgent`, `ToolDispatchService`).
- A blocked or failing mask still withholds the whole text (fail closed).
- Reserved shapes are counted with the new `reservedShapes` option of
  `countUnresolvedSurrogates` (plugin-api 1.112.0); no backfill is needed, since no real value has
  those shapes.

### Consequences

- 🟢 **Good:** One old note or process no longer hides the others.
- 🟢 **Good:** The common path is one mask call, as before.
- 🔴 **Bad:** After a refusal, a cheap placeholder count per entry (no detector) and one more
  mask call over what is left — on every turn for as long as such an entry exists. The boot log
  names the count (`[privacy] … stored entries withheld`) so an operator can remove them.
- 🟢 **Good:** Writes are refused when they carry an earlier turn's reserved placeholder, so no new
  stale entries are stored.
- 🔴 **Bad (residual, from ADR-0191):** a pool *person name* in an old note looks like a real
  name and is not detected.

## Pros and Cons of the Options

### A — Whole first, then per entry

- 🟢 No cost unless needed; precise when needed.
- 🔴 Two code paths.

### B — Always per entry

- 🔴 One mask call per entry on every read.

### C — Replace in place

- 🔴 Needs the shield's shape matcher in the kernel; a note with a replaced value can still read
  as a misleading fact.

## More Information

Issue #2296; ADR-0191, ADR-0295.
