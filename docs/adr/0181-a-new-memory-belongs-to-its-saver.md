# 0181 — A new memory belongs to its saver; sharing goes only through add-owner, to real users

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Owner decision of 2026-11-24 ("private knowledge always stays private",
  ADR-0040), applied by recommendation in #1852 and #1821 (wave 5, W01); reversible.
- **Supersedes:** —

## Context and Problem Statement

`POST /api/v1/memory` accepted `aclOwners`, `involvedOmadiaUserIds` and `derivedFromTurnIds`
and kept every id the caller sent. Account B could place an entry in account A's `/memories`
and A's recall, and link any turn of anyone as its source (`DERIVED_FROM`), which graph walks
and provenance reads follow. `POST /:id/owners` accepted any well-formed UUID, and the new
owner never saw the entry in their list, because the list needs an `INVOLVED` edge that only
create wrote. Who decides the owners of a memory, and through which path?

## Decision Drivers

- Private knowledge always stays private; writing into another person's recall is a memory
  write to a reader who did not consent (ADR-0019, ADR-0040).
- One sharing path, which the owner takes deliberately and the audit trail records.
- The web UI never sends foreign owners; restricting them costs no feature.
- An owner that is no user is a dangling grant.

## Considered Options

- **A — Create is saver-only (foreign owners refused, foreign source turns dropped); add-owner
  takes real users only and writes the `INVOLVED` edge.**
- **B — Silently ignore foreign owners on create.**
- **C — Keep create open; restrict it once non-admin roles exist** (the issue's option B).

## Decision Outcome

Chosen option: **A**.

- **Create.** Owner and involved user are the saver. `aclOwners` / `involvedOmadiaUserIds`
  naming anyone else answer `400 memory.foreign_owner`; naming only the saver still works.
- **Source turns.** `derivedFromTurnIds` keeps only turns whose recorded user is the saver
  (`getRunForTurn(id).user`); others, unknown ones and turns without a recorded user are
  dropped, counted in `droppedSourceTurns` and logged. Dropped, not refused, because the web
  UI's save sends the current turn and provenance is optional.
- **Add-owner.** `KnowledgeGraph.addOwner` refuses a user without a User-Cluster node
  (`user_not_found` → `400 memory.unknown_user`) and writes the `INVOLVED` edge in the same
  step, so the new owner lists the entry. `removeOwner` drops that edge. Both backends.

### Consequences

- 🟢 **Good:** Nobody can put an entry into another person's list or recall, or tie it to
  their turns, without being its owner first.
- 🟢 **Good:** Sharing is one audited path, and it works (the new owner sees the entry).
- 🔴 **Bad:** API callers that relied on creating shared entries in one call need two calls.
- ⚪ **Neutral:** Kernel paths (promotion, the orchestrator's save tool) call the graph
  directly and are unchanged; they set owners from the turn, not from caller input.

## Pros and Cons of the Options

### A — Refuse foreign owners, drop foreign source turns

- 🟢 Explicit error where the caller asked for something forbidden.
- 🔴 A two-step flow for deliberate sharing.

### B — Silently ignore

- 🟢 No client breaks.
- 🔴 The caller believes the entry is shared when it is not.

### C — Restrict later

- 🟢 No change now.
- 🔴 Contradicts the owner decision; every account is admin today, so "later" never ends.

## More Information

- Code: `middleware/src/routes/memory.ts`, `addOwner` / `removeOwner` in
  `harness-knowledge-graph-neon` and `harness-knowledge-graph-inmemory`.
- Tests: `middleware/test/memoryRoutesOwners.test.ts`,
  `middleware/test/memoryOwnersInvolved.pg.test.ts`.
- Related: ADR-0004, ADR-0019, ADR-0040, [ADR-0180](0180-web-chats-belong-to-the-creating-account.md).
