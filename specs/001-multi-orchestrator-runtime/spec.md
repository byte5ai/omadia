# Feature Specification: Multi-Orchestrator Runtime

**Feature Branch**: `001-multi-orchestrator-runtime`
**Created**: 2026-05-21
**Status**: Ready
**Input**: Operator wants to run multiple independent orchestrator instances in
the platform — e.g. a "public" orchestrator bound to one Teams channel with a
restricted plugin set, alongside a "general" orchestrator bound to a different
Teams channel with the full plugin set. Each orchestrator must access its own
plugin instances, be hot-reloadable without infrastructure restarts, and be
manageable through a UI. The Agent Builder must produce plugins that are
multi-orchestrator-ready from the start.

## Overview

Today the platform runs a single `Orchestrator`: the `@omadia/orchestrator`
plugin builds it once at boot and publishes it as the `chatAgent` service; every
other plugin is activated against one shared, process-global service registry.
This feature turns the orchestrator into a **multi-tenant runtime**: N named
`Orchestrator` instances ("Agents") co-exist in one process, each with its own
plugin set, channel bindings, memory scope, and privacy profile. Configuration
is operator-managed and hot-reloadable — adding an Agent or toggling a plugin
never restarts the process or disturbs other Agents.

Out of scope (handled elsewhere or deferred):

- **Knowledge-Graph ownership / ACL** — already in progress in a separate
  worktree; this feature consumes whatever KG scoping that work produces and
  does not redesign it.
- **Per-record / per-user ACL** on memory — deferred. Visibility here is
  coarse-grained: plugin-enabled ⇒ that plugin's memory scope is visible.
- **Azure AD bot app registrations** — an operational task done outside the
  codebase; the spec assumes the operator provides distinct bot identities.

**Revision note (2026-05-21)**: P1 (US1–US3) was re-baselined after codebase
verification. The platform already has a plugin lifecycle — every plugin exports
`activate(ctx: PluginContext): Promise<Handle>` with `handle.close()`, and
`PluginContext` already provides per-plugin scoping and capability-gated service
accessors. US1–US3 therefore *extend the existing manifest* and *parameterize
Orchestrator construction* rather than introducing a new lifecycle contract or
migrating every plugin.

## Clarifications

### Session 2026-05-21

- Q: Should `force-invalidate` end sessions immediately or drain them? → A: Two
  modes — `drain` (default; the in-flight turn finishes, then the session is
  re-bound and its history kept) and `kill` (immediate end mid-turn, session
  store entry discarded — for a leaked plugin). See research C1/C4.
- Q: How is an unmatched inbound channel key handled? → A: Routed to a
  configurable platform-level `fallbackAgentId` when one is set, hard-rejected
  when it is not; logged either way. Onboarding seeds a minimal-privilege
  fallback Agent as the default target. See research C2.
- Q: Are two privacy profiles enough? → A: Yes — `strict | default` enum for
  this feature, modelled for a later extensible profile table. See research C3.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Plugin Manifest Declares Multi-Instance Safety (Priority: P1)

A platform developer extends the existing plugin manifest so a plugin can
declare whether it is safe to run as more than one instance in one process —
the one piece of metadata the multi-orchestrator registry needs that today's
`manifest.yaml` does not carry.

**Why this priority**: The registry (US4) must know, per plugin, whether it may
activate that plugin for a second Agent. Without the declaration the registry
cannot safely build a second Orchestrator. Small, foundational, blocking.

**Independent Test**: Add `multiInstance` to a plugin's `manifest.yaml`; load it
through `manifestLoader`; confirm the value reaches the `Plugin` object and that
`manifestLinter` rejects a `multiInstance: false` manifest that carries no
justification.

**Acceptance Scenarios**:

1. **Given** the extended manifest, **When** a plugin's `manifest.yaml` declares
   `multiInstance` and `privacyClass`, **Then** `manifestLoader` maps both onto
   the loaded `Plugin` object.
2. **Given** a manifest that omits `multiInstance`, **When** it is loaded,
   **Then** it defaults to `multiInstance: true` — multi-instance is the norm.
3. **Given** a manifest with `multiInstance: false`, **When** it is linted,
   **Then** a non-empty `multiInstanceJustification` is required, else the lint
   fails with a precise error.
4. **Given** a manifest with an unknown `privacyClass`, **When** it is linted,
   **Then** the lint fails — `privacyClass` must be `strict` or `default`.

---

### User Story 2 - Agent Builder Emits the Multi-Instance Manifest Fields (Priority: P1)

An operator uses the Agent Builder to create a plugin. The generated
`manifest.yaml` declares the new fields, and the Builder's manifest step lets
the operator set them.

**Why this priority**: The Builder keeps emitting plugins. Once the manifest
carries the new fields (US1), Builder output must populate them so every new
plugin is registry-ready by construction.

**Independent Test**: Generate a plugin from the Builder; confirm its
`manifest.yaml` carries `multiInstance` and `privacyClass` and that the
generated manifest passes `manifestLinter`.

**Acceptance Scenarios**:

1. **Given** the Builder boilerplate manifests, **When** a plugin is generated,
   **Then** the emitted `manifest.yaml` declares `multiInstance` and
   `privacyClass`.
2. **Given** the Builder's manifest step, **When** the operator creates a
   plugin, **Then** they can set `multiInstance` — with a justification field
   that is required when it is `false` — and `privacyClass`.
3. **Given** a generated plugin, **When** `manifestLinter` runs in the Builder,
   **Then** an invalid multi-instance or privacy declaration blocks the build
   and names the failing check.

---

### User Story 3 - Orchestrator Construction Is Per-Agent Parameterizable (Priority: P1)

Today the `@omadia/orchestrator` plugin's `activate()` builds exactly one
process-global `Orchestrator` and publishes it as the `chatAgent` service. To
run N Agents, an `Orchestrator` must be constructible for a *named Agent* with a
given plugin/tool set — not just once for the whole process.

**Why this priority**: This is the structural unlock for US4. The registry
cannot build N Orchestrators until Orchestrator construction is a parameterized
function rather than a one-shot side effect of plugin activation.

**Independent Test**: Call the extracted Orchestrator-construction function
twice with two different Agent configs; confirm two independent `Orchestrator`
instances result, each with only its own tool set; confirm single-Agent
behaviour is unchanged when it is called once.

**Acceptance Scenarios**:

1. **Given** the orchestrator package, **When** an `Orchestrator` is constructed
   for a named Agent, **Then** it receives that Agent's id, plugin/tool set, and
   privacy profile — not a process-global set.
2. **Given** the refactor, **When** the platform runs with a single Agent,
   **Then** all current single-orchestrator behaviour and tests stay green.
3. **Given** two construction calls in one process, **When** both complete,
   **Then** the two `Orchestrator` instances share no mutable state.

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
plugin's config — and the change takes effect within the SC-002 target window
(≤ 10 s), with no process restart and no disruption to unrelated Agents or
in-flight sessions.

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
   plugin's `close()` runs and its resources are released.
3. **Given** a config change to Agent A, **When** it is applied, **Then** Agent B
   experiences zero downtime.
4. **Given** a multi-machine deployment, **When** config changes, **Then** every
   machine converges to the new config without manual intervention.
5. **Given** a plugin whose `close()` throws during reload, **When** the reload
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
   the session keeps its start-time snapshot of plugins, tools, and memory scope.
2. **Given** a config change, **When** a new session starts afterwards, **Then**
   it uses the updated configuration.
3. **Given** an operator who must apply a routine change immediately, **When**
   they trigger `force-invalidate` in `drain` mode, **Then** each in-flight turn
   finishes and the session is then re-bound to the new config with its
   conversation history retained.
4. **Given** a leaked or compromised plugin that must stop serving now, **When**
   the operator triggers `force-invalidate` in `kill` mode, **Then** the Agent's
   sessions end immediately — mid-turn if necessary — and their session-store
   entries are discarded.

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
   received, **Then** it is routed to the configured `fallbackAgentId` if one is
   set, otherwise hard-rejected, and the event is logged either way — never
   silently dropped.
3. **Given** a binding moved from Agent A to Agent B, **When** the move is
   applied, **Then** subsequent messages route to B while a conversation
   already in flight finishes on A.
4. **Given** a config attempting to bind one channel key to two Agents,
   **When** it is validated, **Then** it is rejected.

---

### User Story 8 - Memory Visibility Scoped by Enabled Plugins (Priority: P3)

An orchestrator can read and write only the memory its enabled plugins are
permitted — each plugin's existing `permissions.memory` declarations — plus a
shared `core` scope. A "public" orchestrator with the Confluence plugin may
read Confluence memory; without the Odoo-HR plugin it structurally cannot read
Odoo-HR memory.

**Why this priority**: Refines the privacy boundary. Valuable but not required
for the basic multi-orchestrator capability to function; the coarse default
("core only" until plugin scopes wire up) is safe in the interim.

**Independent Test**: Configure a public Agent with Confluence but not Odoo-HR;
seed memory entries in both scopes; confirm the Agent reads Confluence entries
and cannot read Odoo-HR entries.

**Acceptance Scenarios**:

1. **Given** a plugin with `permissions.memory` declarations, **When** it is
   enabled for an Agent, **Then** those memory scopes become reachable by that
   Agent.
2. **Given** an Agent's visible memory, **When** memory is queried, **Then** the
   result is the union of its enabled plugins' `permissions.memory` scopes plus
   `core`, and nothing else.
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
   **Then** its multi-instance compatibility and memory scopes are shown.

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
- **A plugin's `close()` throws**: isolated, logged; reload continues for every
  other plugin and Agent.
- **Duplicate channel key across two Agents**: rejected at config-validation
  time (US7).
- **Agent with zero plugins**: valid — a bare LLM agent.
- **Plugin config edited without plugin set change**: the plugin is re-activated
  (`close()` then `activate()`) on the affected Agent only; unaffected Agents
  are untouched.
- **Empty config / no Agents defined**: the platform starts idle and
  serviceable; the operator runs first-boot onboarding, which seeds the
  minimal-privilege fallback Agent and the first working Agent (via UI or CLI).
- **Unmatched channel key**: routed to the configured `fallbackAgentId` if one
  is set, otherwise hard-rejected; logged either way, never silently dropped
  (US7).
- **`force-invalidate` modes**: `drain` lets the in-flight turn finish then
  re-binds the session keeping its history; a turn that exceeds the per-turn
  timeout escalates to `kill`. `kill` ends sessions immediately and discards
  their session-store entries (US6).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The existing plugin manifest — the `manifest.yaml` schema, the
  `Plugin` type, the `manifestLoader`, and the `manifestLinter` — MUST be
  extended with a `multiInstance` boolean and a `privacyClass` enum
  (`strict | default`). No parallel manifest format is introduced.
- **FR-002**: `multiInstance` MUST default to `true` when a manifest omits it;
  a manifest with `multiInstance: false` MUST supply a non-empty
  `multiInstanceJustification`, enforced by `manifestLinter`.
- **FR-003**: The platform's existing plugin lifecycle — `activate(ctx)` /
  `handle.close()` with the per-plugin `PluginContext` — IS the lifecycle
  contract; this feature MUST NOT introduce a parallel one.
- **FR-004**: The Agent Builder MUST emit `multiInstance` and `privacyClass` in
  every generated `manifest.yaml` and expose them in its manifest step.
- **FR-005**: `manifestLinter` MUST block a plugin whose multi-instance or
  privacy declaration is invalid, naming the failing check, in CI and in the
  Builder.
- **FR-006**: `Orchestrator` construction MUST be a function parameterized by a
  named Agent's config (id, plugin/tool set, privacy profile), MUST tolerate
  being called more than once in one process, and MUST leave single-Agent
  behaviour unchanged.
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
  Agent's plugin set, tool set, and memory scope, and MUST keep that snapshot
  until the session ends.
- **FR-014**: Configuration changes MUST affect only new sessions; the system
  MUST provide an explicit `force-invalidate` action with two modes — `drain`
  (let each in-flight turn finish, bounded by the per-turn LLM timeout, then
  re-bind the session, keeping its history; a turn exceeding that timeout
  escalates to `kill`) and `kill` (end sessions immediately and discard their
  session-store entries) — to apply a change to an Agent's existing sessions.
- **FR-015**: Inbound channel messages MUST be routed to the orchestrator that
  owns the matching channel binding; an unmatched message MUST be routed to the
  configured `fallbackAgentId` when one is set, hard-rejected when it is not,
  and logged in either case — never silently dropped.
- **FR-016**: Channel keys MUST be unique across Agents; configuration violating
  this MUST be rejected at validation time.
- **FR-017**: An Agent's memory visibility MUST be the union of its enabled
  plugins' `permissions.memory` scopes plus the shared `core` scope, and nothing
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
- **FR-021**: First-boot onboarding MUST seed a minimal-privilege fallback Agent
  (zero plugins, `strict` privacy profile) and set it as the platform's
  `fallbackAgentId`, so unmatched inbound traffic always has a safe default
  routing target.

### Key Entities

- **Agent (Orchestrator Instance)**: a named, independently configured
  orchestrator — identity (slug, name, description), privacy profile
  (`strict | default` — a two-value enum for now, modelled for later
  extension), status.
- **Agent–Plugin Assignment**: the enablement of a plugin for an Agent, with
  per-Agent plugin configuration.
- **Channel Binding**: a mapping from a channel type + channel key to the Agent
  that owns it; channel keys are globally unique.
- **Plugin Manifest**: the existing plugin `manifest.yaml`, extended by this
  feature with `multiInstance` (+ `multiInstanceJustification`) and
  `privacyClass`. All other manifest fields are unchanged.
- **Plugin Context**: the existing per-plugin runtime container (`PluginContext`)
  — per-Agent scoped, with capability-gated service accessors. Reused unchanged;
  the registry constructs one per (Agent × plugin).
- **Config Snapshot**: the immutable, per-session frozen view of an Agent's
  plugins, tools, and memory scope captured at session start.
- **Memory Scope**: the set of memory paths an Agent may reach, derived from its
  enabled plugins' `permissions.memory` declarations; `core` is the shared scope
  available to every Agent.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can create a second orchestrator bound to a separate
  channel without restarting the process of any already-running orchestrator.
- **SC-002**: Adding or removing a plugin from an Agent takes effect for that
  Agent's new sessions within 10 seconds, with zero downtime measured for any
  other Agent.
- **SC-003**: An orchestrator without a given plugin enabled cannot read that
  plugin's memory scope — verified by an automated test for the public vs.
  general split.
- **SC-004**: 100% of existing plugins carry a valid `multiInstance` declaration
  (with a justification when `false`); `manifestLinter` enforces it in CI.
- **SC-005**: 100% of plugins newly generated by the Agent Builder carry
  `multiInstance` and `privacyClass` and pass `manifestLinter`.
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
  coarse-grained at the plugin / `permissions.memory` level.
- The platform continues to run primarily on Fly.io; "no infrastructure
  restart" means the Node process is not recycled, while Fly machines stay warm.
- The existing dashboard (`web-ui`) and its plugin-UI platform are the host for
  the new "Agents" tab.
- The existing Postgres (Neon) instance is available for configuration storage
  and supports `LISTEN/NOTIFY`.
- Multi-instance is the default expectation for plugins; truly single-instance
  plugins are rare and explicitly justified.
- The existing plugin lifecycle (`activate`/`PluginContext`/`close`), service
  registry, manifest loader/linter, and Builder are reused as-is; this feature
  extends them, it does not replace them.
- `privacy_profile` (Agent) and `privacyClass` (plugin manifest) are recorded in
  this feature — stored, validated, operator-set — but not yet enforced; no
  behaviour branches on their value. A later privacy workstream consumes them.
