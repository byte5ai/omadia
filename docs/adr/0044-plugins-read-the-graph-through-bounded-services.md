# 0044 — Plugins read the graph only through bounded services

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** Owner (Marcel), plan approved on 2026-11-25. It closes the residuals
  of [ADR-0040](0040-one-graph-read-boundary-per-turn.md).

## Context and Problem Statement

[ADR-0040](0040-one-graph-read-boundary-per-turn.md) gave every turn one graph read
boundary (`GraphReadScope`). The tool, the plugin accessors, the walks and the process
tools read through it. It left two residuals:

- A plugin that declared `requires: ["knowledgeGraph@^1"]` (likewise `processMemory`,
  `memoryStore`, `graphPool`) got the **raw service** from `ctx.services.get`
  (`pluginServiceGrants.ts`, `pluginContext.ts`). A `requires:` line costs an uploaded
  plugin nothing, and with it the plugin read every turn, session, process and
  `/memories` tree of the tenant.
- With **no boundary set**, the plugin accessors (`searchTurns`,
  `findEntityCapturedTurns`, `getNeighbors`), the node filter and the process tools
  returned everything. "No boundary" covered jobs and activation. It also covered the
  public MCP endpoint, which dispatches tools outside any turn, and a turn before its
  boundary is bound.

An audit on 2026-11-25 checked the kernel packages and every byte5ai plugin repository
at `origin/main`, including ten repositories not cloned locally. It found:

- **No Hub plugin reads turns, sessions, neighbours or processes raw.**
  - integration-odoo uses `findEntities` (Odoo master data) and `ingest*`.
  - integration-confluence only uses `ingestEntities`.
  - channel-telegram only uses `/memories/pairings/*`.
  - channel-teams and dev-platform use `graphPool` only for their own tables.
- **In the kernel, the plan runner was a real leak:** it reused any process of the
  tenant mid-turn (`processMemory.query`), another agent's included (spec 2042 INV-2).
- **The verifier needs only `findEntities`.**

What does a plugin get, and what happens outside a turn?

## Decision Drivers

- One rule: the services follow the boundary the tool and the accessors already
  follow (ADR-0040), not a rule of their own.
- Inside a turn the boundary is enforced. Outside a turn no boundary exists, so the
  bounded form does not invent one.
- No shipped Hub plugin may break.

## Considered Options

- **A — A bounded form of each service at the grant seam;** only the providers and the
  boundary implementers keep the raw service.
- **B — Withdraw the grants and offer only `ctx.knowledgeGraph`.**
- **C — Keep the grants as a reviewed capability (status quo).**

## Decision Outcome

Chosen option: **A**.

- **Who holds the raw services.** `GRAPH_BOUNDARY_IMPLEMENTERS` in
  `boundedGraphServices.ts` is a closed set, honoured only for `origin === 'bundled'`.
  An upload or local-dev package claiming one of these ids inherits nothing (#789). The
  set:
  - the providers: `knowledge-graph-neon`, `knowledge-graph-inmemory`, `memory`,
    `memory-postgres`;
  - the modules that implement the boundary: `orchestrator`, `orchestrator-extras`
    (recall, tenant review jobs).

  A provider reading back its own registration gets it unchanged. Everyone else gets
  the bounded form, bundled modules included: the verifier, the plan runner, diagrams
  and fast-path. Only a module on the list may `replace` one of the three services: a
  decorator sees every raw call and answers the kernel's own reads.
- **`knowledgeGraph@1`.** Every method of the contract is classified in
  `KG_METHOD_ACCESS`, and the compiler makes a new method pick a class. Methods a
  provider has beyond the contract are not reachable.
  - **Pass:** entity writes (`ingestEntities`, `ingestFacts`) and `stats`.
  - **Entities:** `findEntities` passes outside a turn and in `off` / `enforce`, where
    entity nodes are global. In a context-bound turn it keeps master data no turn
    captured (an Odoo or Confluence sync), plus entities a turn the boundary admits
    captured.
  - **Turn reads:** `searchTurns`, `findEntityCapturedTurns`,
    `searchTurnsByEmbedding`, `getSession` and `getNeighbors` read through the turn's
    boundary, with the same code as `ctx.knowledgeGraph`.
  - **Plans:** reads and writes work only inside a turn and only on plans of the
    turn's own conversation. A plan of another scope reads as missing, and a write
    there throws `out-of-scope`. `listPlansForScope` answers only in `off` / `enforce`:
    plans carry no owners, and recall skips them in context-bound rooms.
  - **Kernel-only:** methods that read or change data across users or agents throw
    `GraphServiceRefusedError` (`kernel-only`). They cover curated memory and its ACL,
    purges, topics, review queues, datasets, run traces, `ingestTurn`, `listSessions`
    and `listRecentPlans`.
- **`processMemory@1`.** Reads see what `query_processes` sees: this agent's processes,
  and none in a context-bound `enforce-strict` / `members` turn. Both use
  `currentProcessReadFilter`. An edit of a process the turn may not read answers
  `not-found`. A write lands only in this agent's scopes, inside a turn; another
  agent's scope throws `out-of-scope`.
- **`memoryStore@1`.** A plugin never reaches the private trees (`orchestrators`, where
  every plugin's `ctx.memory` lives too, `agents`, the plugin-wide and legacy tree of
  every plugin, `contexts`, `sessions`, `chat-sessions`, `ui-prefs`). It
  never reaches loose files at the root either. It reads `core` and the `_*` trees.
  The `_*` trees (operator-seeded: `_rules`, `_brand`) and `core/audit` are read-only
  (ADR-0033). It may use other top-level trees (`pairings`). This holds in and outside
  a turn, and tree names compare case-insensitively. A refusal names the tree at
  most, never the path, because a file name can carry what the file holds.
- **`graphPool` has no bounded form.** It is a SQL pool, granted by the operator
  (`permissions.sql`, C7) and borrowed; it is not a read path of the boundary. A guard
  on the tables a plugin's SQL touches is a separate issue (#2230).
- **No boundary set: fail closed for plugins.** Turn, session, neighbour, plan and
  process reads throw `GraphServiceRefusedError` (`no-boundary`). This covers the
  bounded services and the `ctx.knowledgeGraph` accessors. `boundTurnSearch` answers
  "nothing", and the process tools return no process, so the public MCP endpoint no
  longer reaches the tenant's processes. A turn whose boundary box is still empty
  counts as no boundary.
- **Outside a turn, the explicit form is the raw service.** Kernel code that must read
  the tenant's graph outside a turn (recall, review jobs, purges) holds the raw service
  as a module on the reviewed list above, or through the kernel's own
  `serviceRegistry.get`. Plugins get no tenant read outside a turn. A future need
  comes with a manifest permission the operator sees, and a new ADR.

### Consequences

- 🟢 **Good:** ADR-0040's residuals are closed for three of the four services it named (`graphPool` stays
  operator-granted, see above). A
  `requires:` line on them no longer buys a read past the boundary, and "no boundary"
  means "nothing" for every plugin-facing path.
- 🟢 **Good:** The plan runner reuses only this agent's processes (INV-2).
- 🟢 **Good:** The canary sweep (ADR-0039) probes the services: entry point
  `plugin-service`, all four modes, both backends, plus one run outside a turn.
  With the raw services restored it reports more than 1000 leaks per mode.
- 🔴 **Bad (behaviour change):** In a context-bound `enforce-strict` / `members` room:
  - the plan runner no longer finds earlier plans of the scope, so duplicate-plan GC
    and the verifier-blocked marker are skipped there (both advisory);
  - `findEntities` drops entities that only another conversation captured.
- 🔴 **Bad (behaviour change):** A plugin calling `ctx.knowledgeGraph.searchTurns` from
  a job now gets an error instead of the tenant. No shipped plugin does.
- 🔴 **Bad (residual):** These are not yet covered:
  - Other recall and curation services from the same providers (`contextRetriever`,
    `sessionBriefing`, the bulk review services, …) still go to a declaring plugin raw
    (#2231).
  - Every non-private top-level `/memories` tree is writable by every plugin that
    declares `memoryStore@^1`, as before (#2232).
  - `provide` stays ungated: on a host with no provider, a plugin may register
    `processMemory` itself.

## Pros and Cons of the Options

### A — Bounded form at the grant seam

- 🟢 Same rule as the tool and the accessors; no Hub plugin changes.
- 🔴 One classification table to keep, enforced by the compiler.

### B — Withdraw the grants

- 🟢 Smallest surface.
- 🔴 Breaks integration-odoo (`findEntities`, `ingest*`), channel-telegram
  (`/memories/pairings`) and the verifier.

### C — Reviewed capability

- 🟢 No code.
- 🔴 A `requires:` line in an uploaded manifest is no review; the leak stays open.

## More Information

- Code: `middleware/src/platform/boundedGraphServices.ts`; the seam in
  `pluginContext.ts` (`services.get`); `currentProcessReadFilter` in
  `processMemoryTool.ts`.
- plugin-api 1.96.0: `GraphServiceRefusedError`.
- Tests: `test/boundedGraphServices.test.ts`, `test/pluginServiceGrantGate.test.ts`,
  `test/memoryAccess/canarySweep.ts` (`probeServices`,
  `sweepPluginServicesOutsideTurn`).
- Follow-ups in the plugin repositories:
  - [omadia-notion#4](https://github.com/byte5ai/omadia-notion/issues/4): resolves
    `graphPool` without declaring it;
  - [omadia-agent-odoo-hr#8](https://github.com/byte5ai/omadia-agent-odoo-hr/issues/8),
    [omadia-agent-odoo-accounting#7](https://github.com/byte5ai/omadia-agent-odoo-accounting/issues/7):
    unused `knowledgeGraph` declaration;
  - [omadia-plugin-starter#10](https://github.com/byte5ai/omadia-plugin-starter/issues/10):
    its docs teach the raw service.
- Related: [ADR-0033](0033-memory-tool-protected-trees-and-seeded-rules.md),
  [ADR-0039](0039-memory-access-verified-by-oracle-and-canary-sweep.md),
  [ADR-0040](0040-one-graph-read-boundary-per-turn.md).
