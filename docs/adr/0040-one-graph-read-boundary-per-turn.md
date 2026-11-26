# 0040 — Private knowledge stays private: one graph read boundary per turn for every read path

## Status

Accepted

- **Date:** 2026-11-24
- **Deciders:** Owner decision of 2026-11-24 ("private knowledge always stays private"),
  recorded in #2206; fixes in PRs #2209, #2210, #2212 and #2213 for #2205, #2204, #2208,
  #1825 and #2207.

## Context and Problem Statement

Recall already bounded what a turn reads: per context-memory mode it passes the viewer, the
agent (`viewerAgentSlug`), the audience (`audienceOwners`) or the shared tier (`sharedOnly`).
The other read paths did not share that bound. The canary sweep
([ADR-0039](0039-memory-access-verified-by-oracle-and-canary-sweep.md)) showed:

- In `off` and `enforce`, `query_knowledge_graph` ran with no view: other agents' turns,
  pre-agent scopes and other users' private chats (#2204). A plugin's `searchTurns` /
  `findEntityCapturedTurns` passed its options through unchanged.
- In `enforce-strict`, the durable recall leg got no `sharedOnly`, so private operator notes
  reached a context-bound room (#2205).
- A plugin's `getNeighbors` and the `kg_graph` walk sent to the client applied no access check
  one or two hops out (#2208, #1825).
- `query_processes` and `run_stored_process` had no agent or mode bound (#2207).

Spec 2042 INV-2 says an agent gets no other agent's memory. Which rule binds every read path,
and where does it live?

## Decision Drivers

- One rule, not one per path: a new read path must not need its own reasoning.
- The rule follows the mode's recall rules, which are already decided and tested.
- Inside a turn, fail closed: no boundary, no read through the kernel tool.

## Considered Options

- **A — Derive one graph read boundary (`GraphReadScope`) per turn and apply it to every read
  path: tool, plugin accessors, walks, process tools.**
- **B — Patch each path with its own filter.**
- **C — Restrict at the store, by tenant and agent only.**

## Decision Outcome

Chosen option: **A**.

- **The decision.** In every mode a turn sees its own agent's memory plus memories other
  agents shared (`team` / `public`; a memory without a visibility counts as `team`, as in
  recall), and only what the people reading may see. A private or `shared:<x>` memory never
  reaches a turn read by someone who does not own it, and never reaches a context-bound
  `enforce-strict` turn.
- **`GraphReadScope` kinds.** `user` for `off` / `enforce`: this agent's turns that the turn's
  user sent; session reads of the turn's own conversation return it in full, while
  `search_turns` and semantic search there stay limited to the user's turns. `conversation` / `members` for
  context-bound `enforce-strict` / `members`. A turn without a user sees nothing in the graph (process tools: see below).
- **Knowledge-graph tool and plugin search** read through the boundary; sessions through
  `getSession(scope, { userId })` (plugin-api 1.94.0: `SessionReadOptions.userId`,
  `scopeBelongsToAgent`). The CLI-path registration knows no turn and sees nothing.
- **Durable recall leg** passes `sharedOnly` whenever the room is restricted, like the other
  curated-memory legs.
- **Node filter** (`graphNodeAccess.ts`): one admit decision per node kind built from the
  boundary and the mode's recall rules. `getNeighbors` inside a turn and the `kg_graph` walk go
  through it; the walk starts from the turn's own recall hits and follows only admitted nodes.
- **Process tools** read only this agent's processes; none in a context-bound `enforce-strict`
  / `members` turn. A process the turn may not read answers like a missing one. In a turn
  without a user (or under a `nothing` boundary) they still return this agent's processes.
- **No boundary set** (jobs, activation, any scope outside a turn): only the kernel tool
  dispatch fails closed. The plugin accessors (`searchTurns`, `findEntityCapturedTurns`,
  `getNeighbors`), the node filter and the process tools return everything and rely on the
  caller. Nested scopes that rebuild the turn context must carry the boundary box by
  reference (skill-bound tools do since #2210).

### Consequences

- 🟢 **Good:** The sweep's `KNOWN_LEAKS` is empty; the ordinary assertion guards every path.
- 🟢 **Good:** A new read path gets the boundary instead of a new rule.
- 🔴 **Bad (behaviour change):** Users lose cross-agent and cross-user search through the
  graph tool (the tool tells the model why); the knowledge-graph side panel shows fewer nodes.
- 🔴 **Bad:** Outside a turn (jobs, activation) the plugin accessors and process tools are
  unchanged; they rely on the caller.
- 🔴 **Bad (residual):** A plugin that declares `requires: ["knowledgeGraph@^1"]` (likewise
  `graphPool`, `processMemory`, `memoryStore`) gets the raw service from
  `pluginServiceGrants.ts` and bypasses the boundary. Closing that needs a bounded service
  form; until then such grants are a reviewed capability.
- ⚪ **Neutral:** `edit_process` / `write_process` and other plan readers (`listRecentPlans`)
  are not covered yet. Web chat sessions without an owner (#1762) stay a residual.

## Pros and Cons of the Options

### A — One boundary per turn

- 🟢 Same rule as recall; tested end to end by the sweep.
- 🔴 Touches the tool, plugin context, stream and process tools at once.

### B — Per-path filters

- 🟢 Small, local PRs.
- 🔴 This is how the gaps arose; rules drift between paths.

### C — Store-level tenant/agent filter

- 🟢 Simple and central.
- 🔴 Does not express users, audiences or the shared tier; `members` and `enforce-strict`
  would still leak.

## More Information

- Docs: `docs/security-architecture.md` (rules added, residuals removed).
- Closed by [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md): the raw
  service grants (a plugin now gets a bounded form) and the reads with no boundary set
  (plugin-facing paths fail closed).
- Related: ADR-0016, ADR-0019, [ADR-0033](0033-memory-tool-protected-trees-and-seeded-rules.md).

## Errata

- 2026-11-26: The neutral consequence "`edit_process` / `write_process` … are not covered
  yet" no longer holds for the process write tools (#2223): `edit_process` changes only a
  process the turn may read, `write_process` stores only in this agent's scopes and nothing in a
  context-bound turn or without a boundary. `listRecentPlans` is unchanged.
