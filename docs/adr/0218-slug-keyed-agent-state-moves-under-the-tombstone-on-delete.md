# 0218 — Slug-keyed agent state moves under the tombstone on delete, so a reused slug starts empty

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia owner (decision after recommendation, reversible); issue #1881
- **Supersedes:** —

## Context and Problem Statement

Deleting an agent keeps a tombstone (#2088): the `agents` row stays, its slug is replaced by
the placeholder `deleted-<20 hex of the id>` (`tombstoneSlug`), and the slug is free for a new
agent. Several stores key the agent's data by its slug, not by its id (ADR-0163: the runtime's
`agentId` is the slug; the memory scope is `['core', 'orchestrator:<slug>:*']`). Seen live: an
agent stored a code word in memory, was deleted, and a new agent with the same slug and a new
id answered with that code word. How does the state of a deleted agent stay with that agent
instead of passing to the next agent that takes its slug?

## Decision Drivers

- A new agent must start empty; the operator must not have to know which stores exist.
- Nothing may be deleted without the ADR-0120 guarantees (complete, previewed, audited).
- Re-keying every store from slug to agent id is a migration across the memory tree, the graph
  scopes and their external ids, and every reader; it is out of proportion to the bug.
- Where a store cannot be moved safely, the slug must not be reusable while its state exists.

## Considered Options

- **A — Migrate on delete:** move the slug-keyed state under the tombstone's placeholder slug,
  remove what has no value without the agent, and refuse a new agent a slug that still has
  state the move could not take.
- **B — Re-key everything to the agent id.**
- **C — Purge on delete.**
- **D — Warn only** (the delete dialog lists what stays).

## Decision Outcome

Chosen option: **A** (`middleware/src/platform/agentSlugState.ts`, wired into
`DELETE /api/v1/operator/agents/:slug`, `POST /api/v1/operator/agents` and
`POST /api/v1/operator/agents/onboarding/first-agent`). Owner decision after recommendation,
reversible.

**Inventory of slug-keyed state** (what a new agent with the slug would have inherited):

| State | Key | On delete |
|---|---|---|
| Private memory tree | `/memories/orchestrators/<slug>/` (incl. `plugins/<id>` of `ctx.memory`) | moved to `/memories/orchestrators/<tombstone slug>/` |
| Context and `members` tiers | `/memories/contexts/<slug>/` (incl. `members-index`) | moved to `/memories/contexts/<tombstone slug>/` |
| Discretion labels of moved notes | `discretion_labels` (`memory_file`, by path) | move with the notes (`LabelledMemoryStore.rename`) |
| Public MCP key bindings | `public_mcp_key_bindings.agent_id` | removed |
| Graph conversation history | scopes `<slug>::…` on `Turn`, `Session`, `Run`, `ToolCall`, `Plan`, … | stays; blocks the slug (see below) |
| Curated memory | `MemorableKnowledge.origin_agent = <slug>` | stays; blocks the slug |
| Ended by #2088's end of service | subscriptions, execution scopes, reservations | already ended before the delete |

- **Move, not delete.** A delete, after the registry reload, renames both memory trees to the
  tombstone's placeholder slug. They remain reachable by the Danger-Zone purge (ADR-0120,
  axis `agent`, selector = the placeholder slug): previewed, audited, complete. Nothing is
  deleted on the delete path except the MCP key bindings.
- **Bindings go.** A public MCP key bound to a deleted agent has no agent to reach; left in
  place it would reach the tools of the next agent with that slug. The delete removes the
  slug's rows.
- **The graph is not moved.** The external ids of turns, sessions, runs and tool calls embed the
  scope (`turn:<slug>::…`), and facts and other tables point at those ids. Rewriting them is not
  safely possible. Instead, **creating an agent with a slug that still has state is refused**
  with `409 slug_state_remains` (counts of graph history and curated memory, the memory trees,
  the binding key ids). The operator purges the old slug in the Danger Zone (axis `agent`,
  selector = the slug) or picks another slug. The same check catches a memory move that failed
  and state left by deletes from before this change. When the check cannot answer, the create
  is refused with `503 slug_state_unverifiable` (fail closed).
- **Never blocks the delete.** A move or removal that fails is listed in the delete response
  (`slug_state.failures`) and in an `agent.slug_state_moved` audit row; the create check then holds the
  slug.
- ADR-0163's statement that the live agent's memory scope is `orchestrator:<slug>:*` stays
  true; this record only decides what happens to that state once the slug is freed.

### Consequences

- 🟢 **Good:** A reused slug starts with no memory, no MCP key bindings and no graph history of
  the deleted agent; the memory of the deleted agent is not lost and stays purgeable.
- 🟢 **Good:** No new delete path: erasure keeps going through the ADR-0120 purge.
- 🔴 **Bad:** An agent that ever had a conversation leaves graph history, so reusing its slug
  needs a purge first. The refusal says exactly what to purge.
- 🔴 **Bad (residual):** Not covered, recorded here as accepted for now:
  - Web chat tabs keep their transcript and the client sends the slug it was opened with; a tab
    of the deleted agent talks to the new one with its own (the same user's) history. The
    server-side session pin is not a guard here: a client `PUT` of the session drops it.
  - The Quality Guard's `agent_overrides` map (plugin setup, keyed by slug) is operator-written
    configuration and still applies to a new agent with the slug.
  - Routines bound by slug (#1745).
  - Session transcripts under `/memories/sessions/<scope>` are shared by design (ADR-0116,
    ADR-0120 open point).
  - Tuning state keyed by slug in the graph provider (`agent_priorities`, `nudge_state`,
    `nudge_emissions`), the AI-disclosure "seen" marks (`own-identity::<slug>::…`) and the
    discretion audit's `agent_slug` column.
  - `previewDraftAgents` (Plugin Builder previews) create agents outside these routes; their
    slugs carry a reserved prefix.
- ⚪ **Neutral:** Choosing B later stays possible; the move keeps the data where B would find it
  under the tombstone.

## Pros and Cons of the Options

### A — Migrate on delete, refuse what cannot move

- 🟢 Small, local change; uses the existing tombstone and purge.
- 🔴 The graph needs a purge before a slug can be reused.

### B — Re-key to agent id

- 🟢 Removes the class of bug for good.
- 🔴 Touches every store, the graph's external ids and every reader; a data migration.

### C — Purge on delete

- 🟢 Simple; the slug is free at once.
- 🔴 Deletes without a preview, contrary to ADR-0120, and loses data an operator may need
  (erasure requests, audits) the moment someone clicks delete.

### D — Warn only

- 🟢 No data touched.
- 🔴 The leak stays; a warning in a dialog is easy to miss and does not cover the API.

## More Information

- Issue #1881; tombstones #2088 (`registry/tombstones.ts`); end of service
  (`platform/agentEndOfService.ts`).
- Code: `middleware/src/platform/agentSlugState.ts`, `middleware/src/routes/operatorAgents.ts`
  (delete and create paths), wiring in `middleware/src/index.ts`.
- Tests: `middleware/test/agentSlugState.test.ts`.
- Related: [ADR-0012](0012-agents-are-virtual-employees.md),
  [ADR-0163](0163-agent-runtimes-built-from-config-snapshot-and-reloaded-by-diff.md),
  [ADR-0120](0120-memory-purge-is-complete-previewed-and-audited.md),
  [ADR-0116](0116-context-memory-modes-and-tiers.md),
  [ADR-0117](0117-graph-memory-lifecycle-tiers-decay-and-quotas.md),
  [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md),
  [ADR-0019](0019-discretion-as-information-flow-control.md),
  [ADR-0143](0143-public-mcp-endpoint-is-stateless-and-default-deny.md).
