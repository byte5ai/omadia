# 0295 — Process ids are opaque; old ids resolve through `legacy_id`

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** Wave lead (technical decision 2026-11-27, issue #2296), W31 cluster lead
- **Supersedes:** [ADR-0118](0118-graph-nodes-stay-small-bulk-data-in-sidecar-tables.md) in part (its process id
  `process:<scope>:<slug(title)>`); replaces invariant 4 of the `processMemory@1` contract: "id is deterministic"

## Context and Problem Statement

A stored process had the id `process:<scope>:<slug(title)>`. Under prompt masking, processes are
now stored with the user's real values (the ADR-0191 rule, applied to processes in #2296). The
slug would then carry those values — an e-mail, an IBAN, a name — into an id that
`query_processes`, `run_stored_process` and `write_process` hand to the model, and the read-path
re-mask does not catch slugged forms. How are processes identified without leaking their title?

## Decision Drivers

- Nothing of the title (or the scope) in an id the model reads.
- References that already exist (transcripts, plans, label rows keyed by the old id) keep working.
- No cross-database step: the process tables (Neon series) and the discretion labels (core
  series) can live in different databases.

## Considered Options

- **A — Opaque random ids (`process:<uuid>`), old ids rewritten and kept as `legacy_id`.**
- **B — Slug from the masked title.**
- **C — Hash of tenant, scope and title.**

## Decision Outcome

Chosen option: **A**.

- **New ids.** `newProcessId()` (plugin-api 1.112.0) mints `process:<uuid>` on `write`; the id is
  stable across edits. `buildProcessId` is deprecated.
- **Migration** Neon `0040_process_opaque_ids.sql`: every process whose id is not of the opaque
  form gets a new id; its `process_history` rows follow; the old id is kept in
  `processes.legacy_id` (unique per tenant). Idempotent.
- **Resolution.** The Neon store resolves `get`, `edit` and `history` by either id
  (`id = $2 OR legacy_id = $2`) and returns `ProcessRecord.legacyId`.
- **Labels.** The kernel's labelled `processMemory` reads discretion labels under the current and
  the legacy id, so labels kept under the old id (migration 0112) are not lost; new writes keep
  them under the new id. No rewrite of `discretion_labels` is needed.

### Consequences

- 🟢 **Good:** The id names nothing; restoring real values into title and steps cannot leak
  through it.
- 🟢 **Good:** Old ids in transcripts and plans still work.
- 🔴 **Bad:** The same title no longer yields the same id; duplicates are caught only by the
  existing embedding dedup (Dedup-First-Write), as before for re-worded titles.
- 🔴 **Bad:** Label reads for processes written before 0040 look up two subject ids.
- 🔴 **Bad:** A user purge deletes processes but not their discretion labels (old gap, now also
  under the legacy id).
- ⚪ **Neutral:** The scope stays a column; it is no longer part of the id.
- ⚪ **Neutral:** An older build writing during a rolling deploy can still mint a slug id after
  0040; the Neon plugin re-keys such rows on every boot (`rekeyLegacyIds`).

## Pros and Cons of the Options

### A — Opaque ids

- 🟢 No information in the id; simple.
- 🔴 One migration and a resolution path for old ids.

### B — Slug from the masked title

- 🔴 The surrogate changes per turn, so the id would be ambiguous across turns (the #1841
  problem in another place); an id would mean different processes in different turns.

### C — Hash

- 🔴 A hash of low-entropy values (a name, an e-mail) can be brute-forced; no gain over a UUID.

## More Information

Issue #2296; ADR-0191, ADR-0296; migration 0112 (discretion labels for processes).
