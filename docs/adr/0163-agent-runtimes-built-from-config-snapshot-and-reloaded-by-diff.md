# 0163 — Agent runtimes are built from a Postgres config snapshot and hot-reloaded by diff

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); design in
  `specs/001-multi-orchestrator-runtime/spec.md` (US1–US9) and
  `specs/002-chat-routes-via-registry/spec.md`; later changes #1476, #1598, #2055, #2088
- **Supersedes:** —

## Context and Problem Statement

The kernel used to build one `Orchestrator` at boot and publish it as `chatAgent@1`; every
turn ran on it with every plugin's tools. ADR-0012 decides that a person talks to named
agents and how routing picks one. It does not record the runtime below that: where an
agent's configuration lives, how many runtimes exist in the process, and how a change
reaches a running kernel. This record is retroactive. How do several agents run in one
process, and how does an edit take effect without a restart?

## Decision Drivers

- Adding or changing one agent must not restart the process or disturb turns of other agents.
- The plugin set of an agent is its authorisation; a grant or a revocation must take effect
  at once.
- One broken agent or one vanished plugin must not take all agents down.
- The existing plugin lifecycle (`activate(ctx)` once per process) should stay.

## Considered Options

- **A — One in-process registry that builds a runtime per enabled agent from a database
  snapshot and applies changes as a diff.**
- **B — Per-agent plugin activation** (`PluginContext.agentId`, one plugin instance per agent).
- **C — One process or container per agent.**
- **D — Rebuild everything on any change.**

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-orchestrator/src/registry/`).

- **Configuration is rows.** `agents`, `agent_plugins`, `channel_bindings` and the tables
  added since (`middleware/migrations/0001_multi_orchestrator.sql` onwards) are read as one
  `ConfigSnapshot` by `ConfigStore.loadSnapshot()`.
- **One runtime per enabled agent.** `OrchestratorRegistry` calls `buildForAgent` for every
  agent with `status = 'enabled'`; each gets its own `Orchestrator`, `ChatSessionStore` and
  `SessionLogger`. A disabled agent is treated as absent.
- **Plugins activate once, globally.** The registry does not activate plugins per agent. An
  agent's enabled `agent_plugins` rows are passed into the build as its grants and enforced
  at dispatch (ADR-0016). A plugin may declare `multi_instance: false` in its manifest
  (default `true`; `false` requires a `multi_instance_justification`); `validateSnapshot`
  rejects a snapshot that enables such a plugin on more than one agent.
- **Changes are a diff.** `diffSnapshots` is pure and yields `add`, `remove`, `rebuild` or
  `update` per agent. A change of runtime fields, the agent graph, the consultable
  colleagues or the enabled plugin set (`plugin_grants`) rebuilds that agent. A binding-only
  change, or a change of the reserved `privacy_profile`, is a metadata `update`. An
  unchanged database yields no action, and unchanged agents keep their instance.
- **Failure stays local.** A throw while building one agent is logged and the remaining
  actions run. A binding to a plugin that is no longer installed is demoted to disabled and
  logged once (`quarantineUnsatisfiablePlugins`) instead of failing validation for everyone.
- **Three triggers.** Write routes call `registry.reload()` inline. A `ReloadBus` reconciles
  every 60 s. The `notify_agents_changed` trigger sends `agents_changed`, but the registry's
  bus is created without `enableListen`, so on main it does not listen; ADR-0034 has the
  rules for buses that do.
- **Sessions pin a slug, not a build.** `snapshotForAgent` records `agentSlug`;
  `lookupForSession` always returns the agent's current build, so a rebuild applies from the
  next turn (#1476). `forceInvalidate` either clears the pin (`drain`, history kept) or
  deletes the session (`kill`).
- **Without Postgres there is no registry.** The legacy `chatAgent@1` bundle is then the
  deployment's single agent. With a registry, `createScopedChatAgent` never serves a turn
  from it: a turn resolves to a registry agent or gets the `no_agent` system notice; only
  canvas turns still run on the instance default agent until they dispatch per agent
  (#2059). Operator routes answer `503 multi_orchestrator_unavailable` without a registry.

### Consequences

- 🟢 **Good:** Removing or adding an agent leaves the other agents' instances untouched
  (`orchestratorRegistryHotReload.test.ts`, SC-001/SC-002).
- 🟢 **Good:** Granting or revoking a plugin is armed by a rebuild, not by the next restart.
- 🔴 **Bad:** Plugin state is shared between agents. Isolation between agents rests on
  dispatch-time grants and the memory scope `['core', 'orchestrator:<slug>:*']`, not on
  separate plugin instances; the registry's header comment calls per-agent activation the
  cleaner design and defers it.
- 🔴 **Bad:** A change written by another process or directly in the database is picked up
  only by the reconcile, up to 60 s later.
- 🔴 **Bad:** A rebuild replaces the agent's `Orchestrator` and, per the comment in
  `applyDiff.ts`, rolls every live session of that agent; the list of rebuild reasons has
  to stay both complete and minimal.
- 🔴 **Bad:** `agents.privacy_profile` is stored and shown but enforced nowhere (#978).
- ⚪ **Neutral:** `multi_orchestrator_settings.fallback_agent_id` remains in the base
  migration; the fallback agent's special role was removed by ADR-0012.

## Pros and Cons of the Options

### A — Registry, snapshot, diff

- 🟢 Fits the existing plugin lifecycle.
- 🔴 Shared plugin instances; one rebuild rule per kind of change.

### B — Per-agent plugin activation

- 🟢 Real instance isolation per agent.
- 🔴 Needs a deeper change of the tool-plugin runtime; deferred in the code.

### C — One process per agent

- 🟢 Strongest isolation.
- 🔴 Every kernel service would exist once per agent; routing would need a layer above.

### D — Rebuild all on change

- 🟢 No diff logic.
- 🔴 Every edit would touch every agent's instance.

## More Information

- Related: ADR-0012 (agents and deterministic routing), ADR-0016 (grants and the agent
  envelope), ADR-0034 (`ReloadBus`, notifications are hints), ADR-0146 (web chat session
  pinned to one agent, `409 agent_mismatch`), ADR-0081 (model policy).
- Code: `registry/index.ts` (`OrchestratorRegistry`, `validateSnapshot`), `applyDiff.ts`,
  `configStore.ts`, `reloadBus.ts`, `tombstones.ts`; `scopedChatAgent.ts`; wiring in
  `middleware/packages/harness-orchestrator/src/plugin.ts`; `pluginCapabilities` lookup in
  `middleware/src/index.ts`; `middleware/src/plugins/builder/manifestLinter.ts`
  (`multi_instance_justification_missing`); `middleware/src/routes/operatorAgents.ts`.
- Tests: `middleware/test/orchestratorRegistry.test.ts`,
  `orchestratorRegistryHotReload.test.ts`, `reloadBusNotifyHint.test.ts`,
  `reloadBusListen.pg.test.ts`.
