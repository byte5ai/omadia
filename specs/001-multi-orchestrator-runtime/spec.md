# Feature Specification: Multi-Orchestrator Runtime

**Feature Branch**: `feat/multi-orchestrator`
**Created**: 2026-05-21
**Status**: Draft
**Input**: Operator wants to run multiple independent orchestrator instances in
the platform — e.g. a "public" orchestrator bound to one Teams channel with a
restricted plugin set, alongside a "general" orchestrator bound to a different
Teams channel with the full plugin set. Each orchestrator must access its own
plugin instances, be hot-reloadable without infrastructure restarts, and be
manageable through a UI. The Agent Builder must produce plugins that are
multi-orchestrator-ready from the start.

## Overview

Today the platform runs a single `Orchestrator` with every plugin wired into one
shared, process-global context. This feature turns the orchestrator into a
**multi-tenant runtime**: N named orchestrator instances ("Agents") co-exist in
one process, each with its own plugin set, channel bindings, memory scope, and
privacy profile. Configuration is operator-managed and hot-reloadable — adding
an Agent or toggling a plugin never restarts the process or disturbs other
Agents.

Out of scope (handled elsewhere or deferred):

- **Knowledge-Graph ownership / ACL** — already in progress in a separate
  worktree; this feature consumes whatever KG scoping that work produces and
  does not redesign it.
- **Per-record / per-user ACL** on memory — deferred. Visibility here is
  coarse-grained: plugin-enabled ⇒ namespace-visible.
- **Azure AD bot app registrations** — an operational task done outside the
  codebase; the spec assumes the operator provides distinct bot identities.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Frozen Plugin Lifecycle Contract (Priority: P1)

A platform developer needs one authoritative definition of what a plugin is —
how it is created, configured, and torn down — so that orchestrators, the
registry, and the Agent Builder all build against the same interface.

**Why this priority**: Every other story depends on this contract. Producing it
last would force a retrofit of all plugins and all Builder output. It is the
foundational, blocking deliverable.

**Independent Test**: Compile `plugin-api` standalone; verify the exported
`Plugin`, `PluginScope`, and extended `PluginManifest` types exist and that a
trivial reference plugin can be type-checked against them.

**Acceptance Scenarios**:

1. **Given** the `plugin-api` package, **When** a developer imports the plugin
   contract, **Then** they receive `Plugin` with `init`, `dispose`, and optional
   `reconfigure`, plus `PluginScope` and `PluginManifest`.
2. **Given** the extended manifest schema, **When** a manifest omits
   `multiInstance`, `memoryNamespaces`, or `privacyClass`, **Then** schema
   validation fails with a precise error.
3. **Given** a plugin that declares `multiInstance: false`, **When** the
   manifest is validated, **Then** a non-empty justification string is required.

---

### User Story 2 - Agent Builder Produces Multi-Orchestrator-Ready Plugins (Priority: P1)

An operator uses the Agent Builder to create a new plugin. The generated
scaffold must satisfy the multi-orchestrator contract out of the box — lifecycle
hooks, no module-level state, scope-based service resolution — and must not be
publishable until it provably does.

**Why this priority**: The Builder runs in parallel and keeps emitting plugins.
Until it is conditioned on the new contract, every plugin it produces is
technical debt that must be retrofitted. Must land immediately after US1.

**Independent Test**: Generate a fresh plugin from the Builder; run the
builder-ready gate against it; confirm all four checks pass and that the
generated `dispose-roundtrip` test is present and green.

**Acceptance Scenarios**:

1. **Given** a newly generated plugin scaffold, **When** the builder-ready gate
   runs, **Then** lifecycle-contract, no-module-state, dispose-roundtrip, and
   manifest-schema checks all pass.
2. **Given** generated plugin code, **When** a developer inspects it, **Then**
   external services are obtained via `scope.services.get(...)` and there is no
   module-scope mutable state.
3. **Given** a plugin that fails any gate check, **When** the operator opens it
   in the Builder, **Then** the publish action is disabled and the failing check
   is named.
4. **Given** the Builder manifest wizard, **When** the operator creates a
   plugin, **Then** they can set `multiInstance`, `memoryNamespaces`,
   `privacyClass`, and `requiredCapabilities`.

---

### User Story 3 - Existing Plugins Migrated to the Lifecycle Contract (Priority: P1)

The platform's existing plugins (channels, integrations, agents, privacy/quality
plugins) must implement `init`/`dispose` and move their process-global state
into the per-scope container, with no change in observable behaviour.

**Why this priority**: The registry cannot instantiate plugins per-orchestrator
until every plugin honours the contract. A single non-compliant plugin with a
leaked timer breaks hot-reload for the whole process.

**Independent Test**: For each migrated plugin, run its `dispose-roundtrip`
test; confirm `init → dispose → init → dispose` leaves zero extra active
handles. Run the full middleware suite and confirm no behavioural regression.

**Acceptance Scenarios**:

1. **Given** any existing plugin, **When** it is initialised and then disposed,
   **Then** every client, timer, and listener it created is released.
2. **Given** the full plugin set, **When** the migration is complete, **Then**
   no plugin reads or writes mutable module-scope state.
3. **Given** the migrated platform, **When** the existing single-orchestrator
   behaviour is exercised, **Then** all current tests stay green.

---

### User Story 4 - Multiple Orchestrators from Operator Config (Priority: P1)

An operator defines two orchestrators in configuration — a "public" one with a
restricted plugin set and a "general" one with the full set — and the platform
runs both as isolated instances in one process. Applying config at this stage
may require a process restart.

**Why this priority**: This is the MVP — the first point at which the headline
capability (more than one orchestrator) actually exists and is demonstrable.

**Independent Test**: Write a config with two Agents; start the platform; send a
message to each Agent's channel; confirm each responds using only its own
plugin set; confirm a plugin enabled for one is unavailable to the other.

**Acceptance Scenarios**:

1. **Given** a config defining two Agents, **When** the platform starts,
   **Then** two isolated `Orchestrator` instances run, each with its own plugin
   set, privacy profile, and channel bindings.
2. **Given** the public Agent without the Odoo-HR plugin, **When** it processes
   a turn, **Then** Odoo-HR tools and data are not reachable from it.
3. **Given** two Agents in one process, **When** one Agent's plugin throws,
   **Then** the other Agent keeps serving requests.
4. **Given** an Agent configured with zero plugins, **When** it starts, **Then**
   it runs as a valid bare LLM agent.

---

### User Story 5 - Hot-Reload Without Infrastructure Restart (Priority: P2)

An operator changes configuration — adds an Agent, toggles a plugin, edits a
plugin's config — and the change takes effect within seconds, with no process
restart and no disruption to unrelated Agents or in-flight sessions.

**Why this priority**: A hard product requirement, but it builds directly on the
US4 registry. Restart-based US4 is the testable foundation; US5 makes it live.

**Independent Test**: With the platform running and a session active on Agent A,
change Agent B's plugin set; confirm Agent B's new sessions reflect the change
within the target window while Agent A's running session is untouched and the
process PID is unchanged.

**Acceptance Scenarios**:

1. **Given** a running platform, **When** a new Agent is added to config,
   **Then** it becomes serviceable without a process restart.
2. **Given** a running Agent, **When** a plugin is removed from it, **Then** that
   plugin's `dispose` runs and its resources are released.
3. **Given** a config change to Agent A, **When** it is applied, **Then** Agent B
   experiences zero downtime.
4. **Given** a multi-machine deployment, **When** config changes, **Then** every
   machine converges to the new config without manual intervention.
5. **Given** a plugin whose `dispose` throws during reload, **When** the reload
   runs, **Then** the error is isolated and logged and the reload completes for
   all other plugins and Agents.

---

### User Story 6 - In-Flight Sessions Are Never Disrupted by Config Changes (Priority: P2)

A user is mid-conversation with an Agent when the operator changes that Agent's
plugin set. The user's running session keeps its original tools, plugins, and
memory scope until it ends; only new sessions see the new configuration.

**Why this priority**: Without it, hot-reload (US5) corrupts live conversations —
the model would see a tool list that changed mid-turn. It is the safety
mechanism that makes US5 usable, hence same band, sequenced right after.

**Independent Test**: Start a session on an Agent; capture its tool set; change
the Agent's plugins; continue the same session and confirm its tool set is
unchanged; start a new session and confirm it sees the new tool set.

**Acceptance Scenarios**:

1. **Given** an active session, **When** its Agent's config changes, **Then**
   the session keeps its start-time snapshot of plugins, tools, and namespaces.
2. **Given** a config change, **When** a new session starts afterwards, **Then**
   it uses the updated configuration.
3. **Given** an operator who must apply a change immediately, **When** they
   trigger a force-invalidate for an Agent, **Then** that Agent's existing
   sessions are ended and re-bound to the new config.

---

### User Story 7 - Channel Routing to the Correct Orchestrator (Priority: P2)

An inbound message from a channel (Teams, Telegram) is routed to exactly the
orchestrator that owns that channel binding, so a "public" bot and a "general"
bot on different channels reach different orchestrators.

**Why this priority**: This is what makes the public/general split real for end
users. It depends on the registry (US4) being able to resolve Agents.

**Independent Test**: Bind channel key X to Agent A and channel key Y to Agent
B; deliver a webhook for each; confirm each is handled by the intended Agent.

**Acceptance Scenarios**:

1. **Given** two channel bindings to two Agents, **When** a webhook arrives,
   **Then** it is dispatched to the Agent that owns the binding's channel key.
2. **Given** an inbound message whose channel key has no binding, **When** it is
   received, **Then** it is rejected or sent to a configured default, and the
   event is logged — never silently dropped.
3. **Given** a binding moved from Agent A to Agent B, **When** the move is
   applied, **Then** subsequent messages route to B while a conversation
   already in flight finishes on A.
4. **Given** a config attempting to bind one channel key to two Agents,
   **When** it is validated, **Then** it is rejected.

---

### User Story 8 - Memory Visibility Scoped by Enabled Plugins (Priority: P3)

An orchestrator can read and write only the memory namespaces contributed by its
enabled plugins, plus a shared `core` namespace. A "public" orchestrator with
the Confluence plugin may read Confluence memory; without the Odoo-HR plugin it
structurally cannot read Odoo-HR memory.

**Why this priority**: Refines the privacy boundary. Valuable but not required
for the basic multi-orchestrator capability to function; the coarse default
("core only" until namespaces wire up) is safe in the interim.

**Independent Test**: Configure a public Agent with Confluence but not Odoo-HR;
seed memory entries in both namespaces; confirm the Agent reads Confluence
entries and cannot read Odoo-HR entries.

**Acceptance Scenarios**:

1. **Given** a plugin declaring `memoryNamespaces`, **When** it is enabled for
   an Agent, **Then** those namespaces become readable and writable by that
   Agent.
2. **Given** an Agent's visible namespaces, **When** memory is queried, **Then**
   the result is the union of its plugins' namespaces plus `core`, and nothing
   else.
3. **Given** a memory entry written by a plugin, **When** another Agent with the
   same plugin enabled reads memory, **Then** it sees that entry — without
   either Agent knowing of the other.
4. **Given** an entry whose origin plugin is later removed from an Agent,
   **When** that Agent reads memory, **Then** the entry persists in storage but
   is no longer visible to that Agent.

---

### User Story 9 - Operator UI to Create and Manage Agents (Priority: P3)

An operator opens an "Agents" tab in the dashboard, creates a new Agent through
a wizard (identity, plugins, channels, privacy profile), edits or disables
existing Agents, and sees which sessions are running per Agent.

**Why this priority**: The capability is fully usable via config + CLI after
US4–US7; the UI is the ergonomics layer. High value, but last in the cascade.

**Independent Test**: Use the UI to create an Agent with a chosen plugin set and
channel binding; confirm the Agent appears, starts serving, and reflects edits
and disable actions made through the UI.

**Acceptance Scenarios**:

1. **Given** the Agents tab, **When** the operator opens it, **Then** they see
   all configured Agents with status, channel bindings, and recent activity.
2. **Given** the create-Agent wizard, **When** the operator sets identity,
   selects plugins, binds channels, and picks a privacy profile, **Then** a new
   Agent is created and (via hot-reload) starts serving.
3. **Given** an existing Agent, **When** the operator edits its plugin set or
   disables it, **Then** the change is applied through hot-reload.
4. **Given** an Agent with running sessions, **When** the operator views it,
   **Then** the running session count is shown and a "drain & reload" action is
   available.
5. **Given** the plugin multi-select, **When** the operator inspects a plugin,
   **Then** its multi-instance compatibility and `memoryNamespaces` are shown.

---

### Edge Cases

- **Plugin removed mid-session**: the session retains the removed plugin via its
  snapshot until the session ends or its TTL expires (US6).
- **Channel binding moved mid-conversation**: in-flight conversation completes on
  the old Agent; the next message routes to the new Agent (US7).
- **`multiInstance: false` plugin enabled on a second Agent**: the registry
  rejects the configuration with a clear error.
- **Dropped `LISTEN/NOTIFY` connection**: a periodic reconcile re-reads config
  so a missed notification cannot leave the registry stale (US5).
- **`dispose()` throws**: isolated, logged; reload continues for everything else.
- **Duplicate channel key across two Agents**: rejected at config-validation
  time (US7).
- **Agent with zero plugins**: valid — a bare LLM agent.
- **Plugin config edited without plugin set change**: handled by `reconfigure`
  where the plugin supports it, avoiding an expensive dispose/init cycle.
- **Empty config / no Agents defined**: platform starts idle and serviceable;
  operator creates the first Agent via UI or CLI.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define a single authoritative plugin lifecycle
  contract (`init`, `dispose`, optional `reconfigure`) in the `plugin-api`
  package, consumed by all plugins, the registry, and the Agent Builder.
- **FR-002**: The plugin manifest schema MUST require `multiInstance`,
  `memoryNamespaces`, `requiredCapabilities`, and `privacyClass`, and MUST
  require a justification when `multiInstance` is `false`.
- **FR-003**: Plugins MUST NOT hold mutable state at module scope; all runtime
  state MUST be created in `init()` and released in `dispose()`.
- **FR-004**: The Agent Builder MUST generate scaffolds that satisfy the
  lifecycle contract, use scope-based service resolution, and include a
  `dispose-roundtrip` test.
- **FR-005**: The system MUST provide a builder-ready gate with four checks —
  lifecycle-contract compliance, no-module-state, dispose-roundtrip, manifest
  schema — and MUST block publishing a plugin that fails any check.
- **FR-006**: All existing plugins MUST be migrated to the lifecycle contract
  with no change in observable single-orchestrator behaviour.
- **FR-007**: The system MUST support multiple named orchestrator instances
  ("Agents") running concurrently in one process, each with an isolated plugin
  set, privacy profile, and channel bindings.
- **FR-008**: Each Agent MUST resolve plugin services through its own scope; an
  Agent MUST NOT be able to reach a plugin it does not have enabled.
- **FR-009**: A failure inside one Agent's plugin MUST NOT degrade other Agents.
- **FR-010**: Agent configuration MUST be persisted in operator-managed storage
  (Agents, their plugins + per-plugin config, channel bindings).
- **FR-011**: The system MUST apply configuration changes (add/remove Agent,
  toggle plugin, edit plugin config, change binding) without restarting the
  process and without downtime for unrelated Agents.
- **FR-012**: Configuration changes MUST propagate to all running machines in a
  multi-machine deployment, with a reconcile fallback if a change notification
  is missed.
- **FR-013**: Each session MUST capture, at start, an immutable snapshot of its
  Agent's plugin set, tool set, and memory namespaces, and MUST keep that
  snapshot until the session ends.
- **FR-014**: Configuration changes MUST affect only new sessions; the system
  MUST provide an explicit force-invalidate action to end and re-bind an
  Agent's existing sessions.
- **FR-015**: Inbound channel messages MUST be routed to the orchestrator that
  owns the matching channel binding; unmatched messages MUST be rejected or
  routed to a configured default and logged, never silently dropped.
- **FR-016**: Channel keys MUST be unique across Agents; configuration violating
  this MUST be rejected at validation time.
- **FR-017**: An Agent's memory visibility MUST be the union of its enabled
  plugins' `memoryNamespaces` plus the shared `core` namespace, and nothing
  else.
- **FR-018**: Memory writes MUST be tagged with their originating plugin so any
  Agent with that plugin enabled can read them, with no direct coupling between
  Agents.
- **FR-019**: The system MUST provide an operator UI to create, edit, disable,
  and inspect Agents, including plugin selection, channel binding, privacy
  profile, and per-Agent running-session visibility.
- **FR-020**: Lifecycle transitions, routing decisions, and reload operations
  MUST emit structured logs carrying orchestrator id, plugin id, and session id
  where applicable.

### Key Entities

- **Agent (Orchestrator Instance)**: a named, independently configured
  orchestrator — identity (slug, name, description), privacy profile, status.
- **Agent–Plugin Assignment**: the enablement of a plugin for an Agent, with
  per-Agent plugin configuration.
- **Channel Binding**: a mapping from a channel type + channel key to the Agent
  that owns it; channel keys are globally unique.
- **Plugin Manifest**: declarative plugin metadata — version, `multiInstance`,
  `memoryNamespaces`, `requiredCapabilities`, `privacyClass`.
- **Plugin Scope**: the per-(Agent × plugin) runtime container holding that
  plugin instance's services, disposables, and configuration.
- **Config Snapshot**: the immutable, per-session frozen view of an Agent's
  plugins, tools, and memory namespaces captured at session start.
- **Memory Namespace**: a named partition of memory contributed by a plugin;
  `core` is the shared partition available to every Agent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can create a second orchestrator bound to a separate
  channel without restarting the process of any already-running orchestrator.
- **SC-002**: Adding or removing a plugin from an Agent takes effect for that
  Agent's new sessions within 10 seconds, with zero downtime measured for any
  other Agent.
- **SC-003**: An orchestrator without a given plugin enabled cannot read that
  plugin's memory namespace — verified by an automated test for the public vs.
  general split.
- **SC-004**: Every plugin completes an `init → dispose → init → dispose` cycle
  with zero net change in active process handles, enforced as a CI gate.
- **SC-005**: 100% of plugins — existing and Builder-generated — pass the
  four-check builder-ready gate.
- **SC-006**: An in-flight session's tool set and plugin set never change as a
  result of a configuration change to its Agent — verified by an automated
  test.
- **SC-007**: A failure injected into one Agent's plugin leaves all other Agents
  serving requests successfully.
- **SC-008**: An inbound message is delivered to the intended orchestrator in
  100% of bound-channel cases; unmatched messages are logged in 100% of cases.

## Assumptions

- Distinct Microsoft Teams bot identities (Azure AD app registrations) for the
  public and general bots are provisioned by the operator outside this codebase.
- Knowledge-Graph ownership/ACL is delivered by a parallel workstream; this
  feature consumes its scoping output and does not redesign KG visibility.
- Per-record and per-user memory ACL is out of scope; visibility is
  coarse-grained at the plugin/namespace level.
- The platform continues to run primarily on Fly.io; "no infrastructure
  restart" means the Node process is not recycled, while Fly machines stay warm.
- The existing dashboard (`web-ui`) and its plugin-UI platform are the host for
  the new "Agents" tab.
- The existing Postgres (Neon) instance is available for configuration storage
  and supports `LISTEN/NOTIFY`.
- Multi-instance is the default expectation for plugins; truly single-instance
  plugins are rare and explicitly justified.
