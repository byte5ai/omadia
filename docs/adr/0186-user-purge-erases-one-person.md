# 0186 — The user purge erases one person: resolved selector, shared memory de-owned, their data and identity deleted

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W02; decision after the recheck recommendation, reversible)
- **Supersedes:** — (refines [ADR-0120](0120-memory-purge-is-complete-previewed-and-audited.md) for the `user` axis)

## Context and Problem Statement

ADR-0120 made the purge "complete" for its selection, and `docs/security-architecture.md` §10q
calls it the operator's tool for erasure requests. On the `user` axis it fell short in three
ways (#1840, #1842, #1843): the admin UI showed only the account id (`users.id`), which the
purge compared raw and found nothing for; it deleted every remembered fact that listed the
person as an owner, including facts other people own too, and its count left out the excerpts;
and it did not reach the person's datasets, the processes they created, their `User` /
`ChannelIdentity` nodes (with e-mail), nor a channel-only user. What does a user purge select
and delete, and what does it leave to the account deletion?

## Decision Drivers

- ADR-0120: delete what the preview showed; audit first.
- ADR-0004 / ACL model: an entry with several owners is each owner's memory.
- ADR-0019 discretion: a person's identity data (name, e-mail) is personal data like the rest.
- The selector must be one the admin UI actually shows.

## Considered Options

- **A — Resolve the person, de-own shared memory, delete their data and identity in the purge;
  account deletion stays a separate step that says so**
- **B — Account deletion runs the user purge**
- **C — Keep deleting shared memory, but warn about it**

## Decision Outcome

Chosen option: **A**, because it fixes the erasure where operators already run it, without
making an account delete silently destructive.

- **Selector resolution** (`resolveUserSelector`): a uuid with a `User` cluster is the omadia
  user id; a uuid that is an account id resolves through the `web:<users.id>` channel identity;
  `<kind>~<id>` resolves through the `<kind>:<id>` channel identity when the graph knows one
  (else it stays a context key, as before). The preview names the resolved id; an unknown uuid
  warns `user_unknown`. The account detail route returns `omadiaUserId`.
- **Owner erasure**: the `aclOwner` purge filter now means "erase this owner": entries they own
  alone are deleted with their excerpts; shared entries lose them, one `memory_acl_audit`
  `shrink` row each, actor = the operator's omadia user id (else the nil-UUID system actor of
  ADR-0185). Counts report deleted, de-owned and excerpts separately.
- **Beyond memory**, only for a resolved person: datasets they own (deleted on their behalf),
  processes they created (new `processes.created_by_omadia_user_id`, stamped by
  `write_process` from the turn; the bounded service never lets a plugin choose it), and their
  identity nodes, last. Conversation turns also match the identity's `<kind>:<id>` as
  `user_id`.
- **Account deletion** stays `DELETE FROM users`; page and dialog state that memory and data
  remain and point to the purge with the shown omadia user id.

### Consequences

- 🟢 **Good:** One purge with the id from the user page removes what names or belongs to the
  person, and co-owners keep shared memory.
- 🟢 **Good:** Every layer is counted in the preview and stored in the audit row.
- 🔴 **Bad:** Processes written before migration 0038 have no creator and are not selected.
- 🔴 **Bad:** A person who logs in again after the purge gets a new cluster (new omadia user
  id). An open web session keeps the deleted id through every renewal until a real sign-in
  (renewal copies the claim): graph ingest of their turns fails and new datasets/processes
  carry the dead id. A purge by that uuid still reaches datasets and processes (they are keyed
  by the raw id); deleting the account revokes the sessions. Erase a person by purge, then
  delete the account.
- 🔴 **Bad:** A purge by omadia user id or account id reaches the member-notes trees, not the
  per-channel context trees `/memories/contexts/<agent>/user/<kind>~<id>` of the person's
  other channel identities; those need one purge per `<kind>~<id>`.
- 🔴 **Bad:** A process belongs to its first writer: purging A removes B's later edits of A's
  process, and B's edits of A's processes stay with A. The erasure is the one exception to the
  append-only `process_history` of migration 0009.
- 🔴 **Bad (kept from ADR-0120):** transcripts under `/memories/sessions` and chat tabs stay.
- ⚪ **Neutral:** Generated bucket files of the person are a separate decision (#1986).

## Pros and Cons of the Options

### A — Purge erases the person; account delete separate

- 🟢 Uses the existing preview/token/audit safeguards for every new layer.
- 🔴 Two steps for a full offboarding.

### B — Account deletion runs the purge

- 🟢 One step.
- 🔴 Deleting a login (e.g. a duplicate account) would erase memory without preview or
  type-to-confirm; channel-only users have no account to delete.

### C — Warn only

- 🟢 No contract change.
- 🔴 The operator cannot erase a person without destroying co-owners' memory.

## More Information

- Issues #1840, #1842, #1843; ADR-0120, ADR-0185.
- Code: `middleware/src/services/memoryPurgeUser.ts`, `routes/memoryPurge.ts`,
  `harness-knowledge-graph-neon` (`memorableKnowledgePurgeSets`, `purgeUserIdentity`,
  migration `0038_process_created_by.sql`, `processMemoryStore.ts`).
