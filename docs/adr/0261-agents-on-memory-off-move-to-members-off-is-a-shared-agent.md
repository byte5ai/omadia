# 0261 — Agents on memory mode `off` move to `members`; `off` is an explicit shared agent

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** Owner (decision 2026-11-27, issue #2290), W31 cluster lead
- **Supersedes:** [ADR-0116](0116-context-memory-modes-and-tiers.md) in part — its rule "existing agents were not switched" and the driver "no flag day" for `off` agents

## Context and Problem Statement

Since wave 5 chats and memories belong to an account (ADRs 0180–0183) and web and API turns
carry an account or key origin (ADR-0182). Agents on context-memory mode `off` still keep one
memory tree for every turn, so every account and every API key of such an agent reads what the
others asked it to remember. Migration 0099 made `members` the default for new agents but left
existing agents on `off` (ADR-0116). Should existing agents keep sharing, and how does an
operator make an agent shared on purpose?

## Decision Drivers

- Owner decision 2026-11-24: private knowledge stays private; 2026-11-27: migrate existing
  agents to `members`, keep `off` only for explicitly shared agents.
- Nothing may be deleted; the switch must be visible and reversible per agent.
- A shared agent must remain possible (e.g. a team-wide FAQ bot).

## Considered Options

- **A — Migrate standard agents to `members`, record the switch, require `shared: true` for `off`.**
- **B — Leave existing agents and only show a warning.**
- **C — Remove `off` entirely.**

## Decision Outcome

Chosen option: **A**.

- **Migration** core `0122_context_memory_off_to_members.sql`: every agent with
  `context_memory = 'off'` and archetype `standard` becomes `members`;
  `agents.context_memory_switched_at` records when. Other archetypes stay as they are: an
  archetype that omits memory (the facilitator) is kept on `off` by the operator API, and SQL
  cannot ask the runtime archetype registry.
- **Notice.** `GET /api/v1/operator/agents/:slug/context-memory` returns `switchedFromOffAt`
  while the column is set; the memory tab says that notes written under `off` are kept in the
  agent tier and no longer read, and that choosing `off` again makes them readable to everyone.
  Any explicit mode write (`ConfigStore.updateAgent` with `contextMemory`) clears the column.
- **`off` is an explicit shared agent.** `PUT …/context-memory` with `mode: 'off'` for an agent
  whose archetype keeps memory answers `409 context_memory_shared_required` unless the body
  carries `shared: true`; the UI asks for an acknowledgement before sending it. The existing
  rule stays: never `off` for an agent with capability grants (`409 context_memory_required`).

### Consequences

- 🟢 **Good:** On every migrated agent, account A, account B, key 1 and key 2 each get their own
  tier (`test/memoryMembersAccountsKeys.test.ts`).
- 🟢 **Good:** Sharing is a recorded operator act (admin audit `agent.context_memory_change`).
- 🔴 **Bad (behaviour change):** Migrated agents no longer read notes written under `off`;
  they stay in the agent tier until an operator returns the agent to `off` or promotes them.
- 🔴 **Bad:** `members` only gives a group tier when the channel reports a complete roster
  (ADR-0116); groups on channels without one lose shared memory after the switch.
- ⚪ **Neutral:** API clients that set `off` must now send `shared: true`.

## Pros and Cons of the Options

### A — Migrate + explicit shared

- 🟢 Matches the owner decision; reversible per agent; nothing deleted.
- 🔴 Old notes become invisible until an operator acts.

### B — Warn only

- 🟢 No behaviour change.
- 🔴 Keeps cross-account reading on every legacy agent; contradicts the owner decision.

### C — Remove `off`

- 🟢 Simplest model.
- 🔴 No shared agents at all; old notes unreachable for good.

## More Information

Issue #2290; ADR-0116, ADR-0180–0183, ADR-0039 (canary sweep).
