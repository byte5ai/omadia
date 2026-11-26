# 0185 — Memory without an owner follows its source; an operator deletes it one by one

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W02; decision after the recheck recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

Two kernel paths create `MemorableKnowledge` with an empty `acl_owners`: the scratch
promotion reaper (consolidated agent notes, `createdBy: 'scratch-reaper'`) and the durable
rules hook (`/memories/_rules/` files, `createdBy: 'system:rules-hook'`). `deleteMemory`
requires the actor to be an owner, so nobody could delete such an entry; the only ways out
were a Danger-Zone purge of a whole axis or SQL (#1829, #1831). The rule entries were also
create-only: a changed or removed rule file never reached its entry, and the duplicate check
was an unescaped `LIKE` prefix (`_` is a wildcard, `a.md` matched `a.md.bak`). The reaper
also read plugin storage under `/memories/orchestrators/<slug>/plugins/<id>/` as notes and
deleted the files it promoted. ADR-0033 left exactly this open ("cleaning them up depends on
#1829 and #1831"). Who may delete memory nobody owns, and how does a system-created entry stay
in step with what created it?

## Decision Drivers

- ADR-0033: rules come only from the seed; agents cannot write `/memories/_rules/`.
- ADR-0120: destructive operator actions are attributable and audited first.
- Owned memory stays with its owners — no operator path around an owner's ACL.
- Plugin storage is plugin state, not agent notes (ADR-0123 physical layout).

## Considered Options

- **A — Source sync plus an operator delete for owner-less entries only**
- **B — Give system entries an owner (the creating operator, or a synthetic user)**
- **C — An admin override on `deleteMemory` for every entry**

## Decision Outcome

Chosen option: **A**, because it removes the dead ends without widening what an operator can
reach.

- **Rules follow their files.** A rule entry is matched on the *exact* path in the first line
  of its rationale (`source-memory-path: <path>`). `promoteRuleFileToDurable` creates, or
  updates text and embedding when the file changed (without an embedder the stale vector is
  cleared for the backfill). `syncDurableRules` runs at boot and after a purge of axis `all`
  (which deletes the rule entries with everything else; the files stay or are re-seeded): one
  entry per file under `/memories/_rules/` (README excluded), and the entry of a file that is
  gone is deleted.
- **Owner-less delete is its own primitive.** `KnowledgeGraph.listOwnerlessMemorableKnowledge?`
  and `deleteOwnerlessMemory?` (plugin-api 1.100.0, optional, `kernel-only` on the bounded
  service). The delete refuses an entry with an owner (`has_owners` → HTTP 409) and writes a
  `memory_acl_audit` `delete` row. A system delete (the sync) records the nil UUID
  `SYSTEM_ACTOR_OMADIA_USER_ID` as actor, since the column is a NOT NULL uuid.
- **Operator surface.** `GET/DELETE /api/v1/admin/memory/ownerless[/:id]` behind `requireAuth`,
  beside the purge router; the delete writes `admin_audit` `memory.ownerless_delete` first and
  is refused when that fails. The Danger Zone page lists the entries (rules marked) with a
  per-entry delete.
- **The reaper skips plugin storage.** Its SQL scan excludes
  `^/memories/orchestrators/[^/]+/plugins/`; plugin files are never scored, promoted or dropped.

### Consequences

- 🟢 **Good:** Editing, removing or renaming a seed rule reaches every install on the next boot.
- 🟢 **Good:** A single stale system entry can be removed without a purge and is on record.
- 🔴 **Bad:** Rules still change only at boot or purge, not the moment a file changes; there is
  no runtime writer of `_rules/` since ADR-0033, so the gap is a restart.
- 🔴 **Bad:** Deleting a rule entry whose file still exists only lasts until the next sync.
  The page says so.
- ⚪ **Neutral:** Needs the Postgres graph (the sync matches rule rows by SQL); the in-memory
  graph lists and deletes owner-less entries but has no rule sync.

## Pros and Cons of the Options

### A — Source sync plus an operator delete for owner-less entries only

- 🟢 Owned memory stays out of reach; the new path only covers what nobody could delete.
- 🔴 Two optional contract methods, forwarded by three decorators.

### B — Give system entries an owner

- 🟢 No new delete path.
- 🔴 A synthetic owner shows up in every ACL reader; the creating "operator" of a reaper run
  does not exist. Existing entries would need a backfill.

### C — Admin override on `deleteMemory`

- 🟢 One method.
- 🔴 Every operator could delete any user's private memory, against ADR-0016 least privilege.

## More Information

- Issues #1829, #1831; ADR-0033 (protected trees, seeded rules), ADR-0120 (purge audit),
  ADR-0123 (layout).
- Code: `harness-orchestrator-extras/src/promoteDurableRule.ts`,
  `scratchPromotionReaper.ts`, `middleware/src/services/durableRulesSync.ts`,
  `middleware/src/routes/memoryOwnerless.ts`.
