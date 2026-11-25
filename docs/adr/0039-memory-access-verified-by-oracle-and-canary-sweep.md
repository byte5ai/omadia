# 0039 — Memory access is verified against a hand-written oracle and a canary sweep

## Status

Proposed

- **Date:** 2026-11-24
- **Deciders:** Maintainers, memory-ACL test plan; PRs #2187 (plan), #2188 (step 1), #2202
  (step 2) and #2206 (step 3), all open. Step 0 is #2179 (ADR-0035).

## Context and Problem Statement

Memory reaches a turn through many paths: recall legs, the memory tool, the knowledge-graph
tool, plugin accessors (`ctx.knowledgeGraph`, `ctx.memory`), process tools, the client stream
(recall cards, the `kg_graph` walk) and per-person REST routes. Each path applies its own
filter, and each filter has been tested by example in its own suite. The access rules depend
on the context-memory mode (`off`, `enforce`, `enforce-strict`, `members`), the viewer (user,
agent, conversation, Privacy Shield, tenant) and the item (owners, visibility, origin agent,
authorship).

No test stated the whole rule set in one place, and none checked that every path obeys it.
Known Postgres coverage gaps (`sharedOnly`, `viewerAgentSlug`, `shared:<x>`) had no test at
all. The goal of the plan: any change that shows a user memory they may not see turns CI red.

## Decision Drivers

- The expected answer must not be derived from the code under test.
- Both backends (in-memory graph and Neon) must give the same answer.
- A leak found must be visible on every run without blocking unrelated work, and must not be
  silently fixed or loosened inside a test PR.
- Each step should be reviewable alone (one PR per step).

## Considered Options

- **A — One seeded world with a unique canary per item, a hand-written oracle, a store-level
  contract and an end-to-end canary sweep through real turns.**
- **B — More example tests per path**, as before.
- **C — Property-based tests over generated worlds only.**

## Decision Outcome

Chosen option: **A**, in steps.

1. **World, oracle, seed** (`middleware/test/memoryAccess/`). One fixed world: two tenants,
   three users, two agents, a Teams DM, two rooms with different members and a web chat per
   user; items in every store, each with a unique canary. `oracle.ts` is a hand-written
   `expected(viewer, mode, item)`. Every verdict names its source (handoff, security
   architecture, CHANGELOG, plugin-api contract, spec 2042). A row no document decides is
   tagged `pinned, not decided` and pins today's behaviour.
2. **Contract across backends.** For every viewer and mode, the store's search with the
   options a real turn of that mode passes must equal the oracle item for item, on the
   in-memory graph and on Neon. Batches that hit the read cap are split again, so the cap
   cannot hide a row.
3. **Canary sweep.** Every viewer runs one real turn per mode through
   `buildOrchestratorForAgent`, with only the model scripted. The model recalls, views every
   path, runs every graph query, calls a probe plugin and the process tools. A forbidden canary
   that reaches the model or the client fails. Every entry point also has a positive control:
   allowed canaries must arrive.
4. Later steps: completeness guards, lifecycle invariants, mutation proof (plan in
   `docs/middleware-agent-handoff.md` §13).

- **Known leaks are `todo` tests naming their issue**, listed once (`KNOWN_LEAKS`). They report
  on every run and do not block CI; the same sighting anywhere else fails. A fix removes the
  entry and the ordinary assertion takes over. Test PRs fix nothing.

### Consequences

- 🟢 **Good:** The rule set is one readable artefact with a source per verdict; gaps in the
  documents show up as `pinned, not decided`.
- 🟢 **Good:** The sweep found real leaks on first run (#2204, #2205, #2207, #2208, plus
  #1825 and #1762); fixes are recorded in [ADR-0040](0040-one-graph-read-boundary-per-turn.md).
- 🟢 **Good:** It bites: removing a viewer filter from a turn search or the memory route turns
  the suite red (checked by hand).
- 🔴 **Bad:** Large, slow suites (Neon legs of 20–60 s per file); the in-memory excerpt search
  had to be split to stay within the per-file duration guard.
- 🔴 **Bad:** The oracle must be updated with every access-rule change; a wrong oracle is a
  wrong spec.
- ⚪ **Neutral:** Admin, operator and `/api/dev/*` routes are not swept (operator-only by
  design today); topics, duplicates, purge preview and promote routes are open.

## Pros and Cons of the Options

### A — World, oracle, contract, sweep

- 🟢 Checks every entry point against one statement of the rules.
- 🔴 High up-front cost; three stacked PRs.

### B — More example tests

- 🟢 Cheap per case.
- 🔴 Tests only the paths someone thought of; this is how the leaks above survived.

### C — Generated worlds only

- 🟢 Finds combinations nobody wrote down.
- 🔴 Needs an oracle anyway; failures are harder to read. Planned as step 5 on top of A.

## More Information

- Related: [ADR-0035](0035-postgres-tests-are-found-by-name-and-held-by-a-floor.md),
  ADR-0016, ADR-0019, `docs/security-architecture.md` (known residuals).
