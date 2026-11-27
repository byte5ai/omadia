# 0190 — Memorable knowledge lifecycle: retired turns, one promotion path, safe auto-merge

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Owner (autonomous wave 5, recommendation of the 2026-11-26 recheck);
  issues #1819, #1835, #1861, #1862, #1864.
- **Supersedes:** —
- **Refines:** [ADR-0004](0004-knowledge-graph-as-memory-substrate.md) (memorable
  knowledge in the graph), [ADR-0019](0019-discretion-as-information-flow-control.md)
  (per-agent isolation of auto-promoted entries).

## Context and Problem Statement

A `MemorableKnowledge` entry (MK) comes from three writers: a person (the save dialog,
`POST /api/v1/memory`), live auto-promotion after a turn, and the operator's bulk
promotion over stored turns. Two jobs then curate the set: the duplicate detector
(which since Slice 13 also deletes duplicates by itself) and the contradiction
detector. No record said how these parts fit, and they disagreed:

- Promotion counted a turn as done only while a `DERIVED_FROM` edge existed. Deleting,
  discarding or merging an entry removed the edge, so the next bulk run minted the
  entry again (#1819).
- Bulk promotion created entries without the excerpt rule (#1527) and without an
  `origin_agent`, so they skipped per-agent isolation (#1819). Public API turns
  (`key:<keyId>`) failed the owner schema on every run and used up the promote
  limit (#1864).
- Auto-merge resolved pairs from cosine 0.90, kept the older entry, and deleted a
  hand-saved correction that differed in one date; the audit row named the owner
  with no reason (#1835).
- Deleting an entry left its open contradiction and duplicate pairs open, and a
  resolution that "kept" the deleted side deleted the last copy (#1862).
- A contradiction verdict cut off at 200 tokens was dropped, and the entry still
  counted as checked, so it was never judged again (#1861).

What is the lifecycle an MK and its source turns follow, and which decisions may a job
take without a person?

## Decision Drivers

- A person's decision stands: what someone deleted or discarded does not come back
  by itself, and what someone saved on purpose is not deleted by a job.
- One promotion path: bulk and live promotion produce the same entry.
- A job's mutation is recognisable as the job's in the audit trail.
- A curation queue never offers an action that destroys the last copy.
- No silent loss: a check whose result was lost is retried.

## Considered Options

- **A — Retirement mark on the turn; jobs act only on machine-made, near-exact
  copies.** Deleting an MK marks its source turns `promotionRetired`; promotion and
  bulk skip marked turns. Auto-merge resolves only near-exact pairs and only retires
  machine-made copies.
- **B — Tombstone nodes for deleted MKs.** Keep a soft-deleted MK row
  (`status=deleted`) that holds the edge and is filtered from every read.
- **C — Turn off auto-merge and bulk promotion.** Leave curation to operators.

## Decision Outcome

Chosen option: **A**, because it fixes every reported path with one mark that already
lives where promotion looks (the turn), keeps deleted content out of the graph, and
keeps automatic dedup for its actual purpose: re-learned copies of the same fact.

The rules:

1. **Retired turns.** `deleteMemory` (used by delete on `/memories`, discard in the
   chat, a resolved contradiction or duplicate pair, and auto-merge) sets
   `properties.promotionRetired = { at, reason: 'memory_deleted' }` on every turn the
   entry was `DERIVED_FROM`, in the same transaction. Live and bulk promotion skip a
   retired turn (`reason='retired'`). A manual save from the turn stays possible. Bulk
   promotion also retires a turn whose outcome cannot change on a later run: no person
   owns it (`no_person_owner`) or the answer was agent narration (`hygiene`).
2. **Only people own memorable knowledge.** A turn whose user or owners are no omadia
   user ids (Public API turns run as `key:<keyId>`) is not promoted
   (`no-person-owner`). Bulk promotion leaves such turns out of its candidate query
   and its "eligible" count. Mapping an API key to its owning user was not chosen: it
   would put what a key's caller said into a person's memory.
3. **One promotion path.** Bulk promotion passes the live inputs: the excerpt
   extractor (masked through the stored-text privacy scope, because stored turns hold
   real values) with `excerptRequired`, `origin_agent` from the turn's qualified scope
   (`<agentSlug>::…`), and the turn's member owners. Skipped turns are counted as
   `skipped`, not `failed`.
4. **Safe auto-merge.** With auto-merge on (manifest field `kg_auto_merge_enabled`,
   default on and seeded into every fresh install; env `KG_AUTO_MERGE_ENABLED` is only a
   fallback for an install whose config holds no value for the field), pairs are
   flagged from cosine 0.90, and a pair is resolved by the job only when it is
   near-exact: cosine ≥ `kg_auto_merge_threshold` (default 0.98) **and** both sides
   carry the same kind, summary and rationale once case, whitespace and punctuation
   are dropped. Any other difference (a date, an amount, a name, "approved" vs
   "rejected") can be a correction and stays an open pair. Only a machine-made entry
   (`created_by` `auto:…`, `system:…`, the scratch reaper) that no person corrected
   (no `corrected_at`, #1863) is ever retired; a hand-saved, user-corrected or
   `manuallyAuthored` entry always wins, and two of them stay an open pair. Two
   machine-made, uncorrected, textually identical copies: the older one wins.
5. **Jobs are audited as jobs.** `AclMutationOptions.systemActor` (`system:<job>`) is
   audit-only: authorisation still checks the owner, but the audit row carries the nil
   actor uuid with the job label, the reason carries the cosine, and the pair's
   `resolved_by` is `null`.
6. **Pairs follow their entries.** Deleting an MK dismisses its open `Inconsistency`,
   `MergeCandidate` and (through its excerpts) `ExcerptMergeCandidate` pairs with
   `closed_reason: 'memory_deleted'`. A resolution that keeps a side which no longer
   exists is refused with `keeper_missing` (HTTP 409) before anything is deleted; the
   detail pages disable those actions.
7. **Lost verdicts are retried.** The contradiction judge gets an output budget that
   fits the answer the prompt asks for (500 tokens). A failed or unparseable verdict
   leaves `last_inconsistency_check_at` unset, so a later bulk sweep judges the entry
   again. Each lost pass is counted (`inconsistency_lost_verdicts`,
   `last_inconsistency_attempt_at`); the bulk queue takes never-attempted entries
   first, and after `INCONSISTENCY_MAX_LOST_VERDICTS` (3) lost passes the entry is
   marked checked with `inconsistency_check_outcome: 'verdict_lost'`, so a pair that
   never gets a verdict cannot hold the head of the queue or cost model calls forever.

### Consequences

- 🟢 **Good:** deleted, discarded and merged-away knowledge stays gone; bulk entries
  look like live ones and keep per-agent isolation.
- 🟢 **Good:** a correction ("November 13" after "November 10") is never deleted by a
  job; it surfaces as an open pair and to the contradiction check.
- 🟢 **Good:** the audit trail tells a job's delete from a person's.
- 🔴 **Bad:** fewer pairs resolve by themselves; paraphrased auto-saved duplicates
  below 0.98 now wait for an operator in `/admin/duplicates`.
- 🔴 **Bad:** a turn retired by mistake can only be promoted again by a manual save
  (or by removing the property); there is no UI to un-retire.
- ⚪ **Neutral:** user-saved is derived from `created_by` rather than
  `manuallyAuthored`: setting `manuallyAuthored` on every hand-saved entry would also
  put it in the durable recall tier and, in member-scoped rooms, make it visible as an
  operator-authored row. #1863 (edits mark an entry authored) is decided separately.
- ⚪ **Neutral:** the bulk route has no discretion guard (`guardMemoryEgress`) like the
  live path; the turn's owners bound the entry instead. A follow-up may add it.

## Pros and Cons of the Options

### A — Retirement mark on the turn, safe auto-merge

- 🟢 One property on the row promotion already reads; no read path changes.
- 🟢 Deleted content leaves the graph, as a person expects from "delete".
- 🔴 The mark is not reversible from the UI.

### B — Tombstone nodes

- 🟢 Keeps the history of what was deleted next to the turn.
- 🔴 Every MK read (recall, lists, topics, purge counts) must filter the tombstones;
  one missed filter resurrects deleted knowledge in recall.
- 🔴 Keeps deleted content stored, against what the delete dialog promises.

### C — Turn the jobs off

- 🟢 No job ever deletes or creates on its own.
- 🔴 Re-learned duplicates pile up again (the reason Slice 13 exists), and bulk
  promotion of historical turns disappears.

## More Information

- Code: `harness-orchestrator-extras/src/{promotion,bulkPromotion,mergeCandidateDetector,inconsistencyDetector,excerptExtractor}.ts`,
  `harness-knowledge-graph-{neon,inmemory}` (`deleteMemory`, `resolveInconsistency`,
  `resolveMergeCandidate`), `plugin-api` (`PROMOTION_RETIRED_PROP`,
  `SYSTEM_AUDIT_ACTOR_UUID`, `AclMutationOptions.systemActor`,
  `BulkPromotePhaseResult.skipped`).
- Tests: `middleware/test/memorableLifecycle.test.ts`,
  `middleware/test/memorableLifecycle.pg.test.ts`, `middleware/test/autoMerge.test.ts`.
- Related: [ADR-0097](0097-unprotected-provenance-for-stored-content.md) (derived MKs
  inherit `unprotected`), [ADR-0100](0100-admin-audit-trail-one-actor-rule.md) (a
  kernel job is audited as `system:<name>`),
  [ADR-0120](0120-memory-purge-is-complete-previewed-and-audited.md) (purge is a
  separate path and does not retire turns).
