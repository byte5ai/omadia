# Feature Specification: Omadia Conductor — Deterministic Workflow Engine, Designer & Human-in-the-Loop

**Feature Branch**: `005-omadia-conductor`
**Created**: 2026-06-16
**Status**: Draft
**Input**: An operator wants to build real, auditable processes that combine
**agentic steps** (an Agent does work) and **human steps** (a person decides,
approves, or supplies input) and that start automatically on real-world events —
e.g. a release pipeline that runs on every merge / RC-build and then asks a human
for release sign-off; a customer-handover preparation; a step that fires when a
calendar appointment approaches; or an applicant flow that starts when a
candidate is set to "invite" in an external ATS. The headline requirement is a
**deterministic harness**: the runtime — not the LLM — owns step progression and
hand-offs, so a process cannot silently stall the way prompt-only multi-agent
frameworks do (an agent that "forgets" to delegate). The operator must be able to
design these workflows visually and conversationally (a sibling of the Agent
Builder), save and later update them, and — after connecting an external system
via a connector plugin — immediately see whether and how that system can interact
with the Conductor.

## Overview

Today omadia runs Agents as single-agent orchestrator loops (`@omadia/orchestrator`,
`buildOrchestratorForAgent`). Multi-agent coordination is **LLM-decided**: an Agent
may call a domain sub-agent as a tool, or a plugin may call `ctx.subAgent.ask(...)`,
but **nothing in the runtime owns the order of steps or enforces a hand-off**. The
canvas Agent Graph (`@omadia/plugin-api` `agentGraph.ts`) is structural wiring, not
an executed sequence. The platform already ships the *atoms* of a deterministic
harness — tool **postconditions** + the verifier (`dynamicAgentRuntime.ts`,
`@omadia/verifier`), the OB-31 tool-obligation / repeat-failure loop guards
(`localSubAgent.ts`), and the `deterministic_action` fast-path
(`deterministicActionRegistry.ts`) — but only **per tool / per turn**, never across
a multi-step process or a hand-off.

This feature introduces **Conductor**: a process layer that promotes those atoms to
**process scope**. A *Workflow* is a declarative graph of **steps** (an agent turn,
a deterministic action, or a human step) connected by **guarded transitions**. The
**Conductor** runtime owns advancement: after each step it evaluates the step's
**exit postcondition** and, when it is unmet, it does not hope the LLM self-corrects
— it acts deterministically (re-inject / force a tool obligation / route to a
declared fallback transition). A hand-off is a transition the Conductor fires, not a
prompt line an Agent can drop.

A **human step** is the same pattern with a person as the actor: its postcondition is
"the addressed principal responded by the deadline"; if unmet, the deterministic
action is "send a reminder"; on deadline it fires the fallback transition. The
addressed principal is either a **specific user** or a **role** (a baton that is
late-bound at dispatch to whoever currently holds it).

Workflows start on **triggers**. Every trigger funnels into a single entry point
(`startRun(workflowId, payload)`); from there the Conductor owns the run. One trigger
class is first-class and designed in from day one: **events emitted by connector
plugins**, declared in the connector's manifest (a self-describing "Conductor
Surface") so the Designer can surface them automatically.

Architecture placement (see Assumptions): Conductor ships **in this repo, modular** —
a pure `@omadia/conductor-core` engine package (sibling of `@omadia/canvas-core`),
kernel wiring in `middleware/src/` via the existing `serviceRegistry`, and a Designer
under `web-ui/app/admin/conductor/` that mirrors the Agent Builder. No separate repo.

Out of scope (handled elsewhere, deferred, or owned by the live instance):

- **Connector plugins themselves** (GitHub/CI, ATS/HR, calendar, ERP, …). Conductor
  defines the *contract* a connector implements; building connectors is separate
  plugin work. Conductor never hard-codes knowledge of any specific connector.
- **The HR/ERP role-movement policy** — *when and why* a baton moves automatically
  (sickness, vacation, org change). Conductor exposes the resolver seam and the
  assignment store/APIs/events; the live instance + its integration own the policy.
- **N-of-M quorum** beyond the two-value `any | all` switch — a later extension.
- **Sub-workflow invocation as the deadline fallback** — per the 2026-06-16
  clarification the deadline fallback is an **in-graph transition only**. Workflow→
  workflow *triggering* is in scope; calling a separate workflow *as a deadline
  handler* is not.
- **Distributed multi-process scheduling** — the existing single-process scheduler
  model (`scheduleWorker`) is reused; horizontal scale-out of the timer loop is a
  later concern, consistent with the platform today.
- **Knowledge-Graph / per-record ACL redesign** — Conductor consumes existing scoping
  and adds only the await/role access rule defined here.

## Clarifications

### Session 2026-06-16

- Q: Conductor as a separate repo or in this monorepo? → A: **In-repo, modular** —
  `@omadia/conductor-core` (pure engine) + kernel wiring via `serviceRegistry` +
  Designer under `web-ui/app/admin/conductor/`. A separate repo would force
  publishing internal `@omadia/*` packages and a cross-repo version matrix for
  something that ships as one Docker image. Only an HR/ERP role resolver belongs in
  a separate, swappable plugin.
- Q: When a human step's deadline passes, branch within the same workflow or call a
  separate sub-workflow? → A: **In-graph branch only** (a guarded transition such as
  "auto-reject" or "escalate"). Keeps the engine lean.
- Q: When a role has several holders, who must respond? → A: **Per-step switch**
  `quorum: any | all` (default `any`). `any` = first responder decides; `all` =
  every current holder must respond.
- Q: How important is the event/condition trigger? → A: **First-class, day one** (not
  Phase 2). The *contract* — a connector's manifest `emits:` block, the event
  catalog, `ctx.events.emit`, the subscription/filter model — ships now. Only the
  connectors themselves are out of scope.
- Q: How is a role resolved to a person? → A: **Late binding** — resolved at step
  dispatch and re-resolved on every reminder, via a pluggable `RoleResolver` seam
  (registered like `LlmProvider`/channels). A default resolver reads omadia's own
  manual assignment table; an integration may register a resolver that consults
  external availability. Access to a pending await is granted to whoever holds the
  role **at access time**, never frozen to a user id.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deterministic Process Engine (`conductor-core`) (Priority: P1)

A platform developer defines a Workflow as a graph of steps and guarded transitions
in a pure, I/O-free engine. The engine, given a current step result, decides the next
step deterministically: it evaluates the completed step's exit postcondition and
selects the matching transition; if no postcondition is satisfied and no transition
matches, it selects the step's declared fallback transition rather than ending
ambiguously.

**Why this priority**: This is the harness — the headline capability. Every other
story builds on a runtime that owns advancement. It is pure and unit-testable in
isolation, exactly like `@omadia/canvas-core`.

**Independent Test**: Construct a three-step workflow with a postcondition on step 1
and two outgoing guarded transitions; feed synthetic step results; confirm the engine
selects the correct next step for a satisfied postcondition, the fallback transition
for an unmet one, and rejects a graph with an unreachable step or a cycle without a
progress guard at validation time.

**Acceptance Scenarios**:

1. **Given** a workflow graph, **When** a step completes with a result that satisfies
   exactly one outgoing transition guard, **Then** the engine advances to that
   transition's target step.
2. **Given** a step whose exit postcondition is unmet, **When** the engine evaluates
   it, **Then** it does not advance on a "happy path" transition; it selects the
   step's declared fallback (or raises a precise "stuck, no fallback" error if none).
3. **Given** a graph with an unreachable step or an unguarded cycle, **When** it is
   validated, **Then** validation fails naming the offending node(s).
4. **Given** the same workflow and the same sequence of step results, **When** the
   engine runs twice, **Then** it produces the identical step path (determinism).

---

### User Story 2 - Durable Run Lifecycle & Resume (Priority: P1)

A workflow run is persisted from start to finish. A run that is waiting (on a human,
a timer, or an external event) survives a process restart and resumes exactly where
it left off when the awaited signal arrives.

**Why this priority**: Without durability the engine is a demo. Real processes wait
hours or days; a restart must not lose a run or double-fire a step.

**Independent Test**: Start a run, advance it to a waiting step, restart the
middleware process, deliver the awaited signal, and confirm the run resumes at the
correct step with its accumulated context intact and no step re-executed.

**Acceptance Scenarios**:

1. **Given** a started run, **When** it advances, **Then** each completed step and the
   run's accumulated context are persisted before the next step begins.
2. **Given** a run in a `waiting` state, **When** the process restarts, **Then** the
   run is rehydrated and remains `waiting` — no step is re-executed and no timer is
   lost.
3. **Given** a waiting run, **When** its awaited signal (human response, timer tick,
   event) arrives, **Then** the run resumes at the waiting step and advances.
4. **Given** a step that throws or times out, **When** the engine handles it, **Then**
   the run transitions to a `failed`/fallback state per the graph — never a silent
   hang with no recorded state.

---

### User Story 3 - Triggers Start a Run (Priority: P1)

An operator (or another system) starts a workflow run. All entry paths — an inbound
channel message, a cron schedule, a manual UI/API start, an Agent calling a
`start_workflow` tool, an external webhook, or another workflow — funnel into one
`startRun(workflowId, payload)` entry point, and the trigger payload becomes the run's
initial context.

**Why this priority**: A workflow that cannot be started is inert. The unified funnel
keeps the engine independent of how a run begins and makes new trigger types cheap.

**Independent Test**: Define a workflow with a manual trigger and a cron trigger;
start it both ways; confirm both produce a run whose initial context equals the
supplied payload and whose first step is the workflow's entry step.

**Acceptance Scenarios**:

1. **Given** a workflow with a manual trigger, **When** an operator starts it with a
   payload, **Then** a run is created with that payload as initial context.
2. **Given** a workflow with a cron trigger, **When** the schedule matches, **Then** a
   run starts automatically, reusing the existing `scheduleWorker` mechanism.
3. **Given** a workflow bound to an inbound channel, **When** a matching message
   arrives, **Then** a run starts with the message as initial context.
4. **Given** a disabled workflow, **When** any trigger fires, **Then** no run starts
   and the suppressed trigger is logged — never silently dropped.

---

### User Story 4 - Event Triggers & the Connector "Conductor Surface" (Priority: P1)

A connector plugin declares, in its `manifest.yaml`, the **events it can emit** (each
with a stable id, label, and a payload JSON Schema) and the **actions it provides**.
On install, the kernel autodiscovers these into an event catalog. When the connector's
external system fires, the connector calls `ctx.events.emit(id, payload)`; the kernel
validates the payload against the declared schema and routes it. A workflow's event
trigger names an event id and an optional filter; a matching emit starts a run with
the validated payload as context. The Designer reads the catalog so the operator
immediately sees which Conductor interactions a freshly connected system supports.

**Why this priority**: This is the trigger class the operator's real use cases depend
on (merge / RC-build, ATS "invite", calendar). Elevated to day-one in the 2026-06-16
clarification. It reuses the existing manifest self-description (`provides:`) and the
"declare → resolve → derive" autodiscovery pattern (canvas-output /
deterministic-action), so it is idiomatic, not a foreign body.

**Independent Test**: Install a fixture connector whose manifest declares an `emits:`
event with a payload schema; confirm the catalog lists it; emit a valid payload and a
schema-violating payload; confirm the valid one starts a subscribed workflow run with
the payload as context and the invalid one is rejected at the seam and logged; confirm
uninstalling the connector removes the event from the catalog.

**Acceptance Scenarios**:

1. **Given** a connector manifest with an `emits:` block, **When** it is installed,
   **Then** each declared event (id, label, payload schema) appears in the event
   catalog and is offered by the Designer as a selectable trigger.
2. **Given** a workflow subscribed to event `X` with filter `F`, **When** the
   connector emits `X` with a payload matching `F`, **Then** a run starts with the
   payload as initial context; a non-matching payload starts no run.
3. **Given** an emit whose payload violates the declared schema, **When** it reaches
   `ctx.events.emit`, **Then** it is rejected with a precise error and logged — no run
   starts on malformed data.
4. **Given** a connector that declares no `emits:`, **When** it is installed, **Then**
   the Designer clearly shows it exposes no Conductor triggers (absence is as explicit
   as presence) while still listing any actions it `provides:`.
5. **Given** a connector that is uninstalled, **When** the catalog is read, **Then**
   its events are gone and workflows that subscribed to them surface a clear
   "trigger source missing" diagnostic rather than silently never firing.

---

### User Story 5 - Human Step with Durable Awaits, Reminders & Deadline (Priority: P1)

A workflow step addresses a human for a decision, approval, or input. The step
notifies the addressed principal on a configured channel and creates a **durable
pending await**. If the human does not respond within the reminder interval, omadia
re-sends a reminder; if an optional deadline passes with no response, the Conductor
fires the step's in-graph fallback transition. When the human responds, the run
resumes. For a role with multiple holders the step's `quorum` decides whether one
response (`any`) or all current holders (`all`) are required.

**Why this priority**: Human-in-the-loop is the explicit product requirement that
distinguishes Conductor from a pure agent pipeline. The durable await is the one
genuinely net-new substrate (today `ask_user_choice` is in-memory and dies on
restart).

**Independent Test**: Build a workflow with a human approval step (target principal,
channel, 6h reminder, 24h deadline, fallback = "auto-reject"); start a run; confirm
the principal is notified and an await row persists; advance the clock past the
reminder with no response and confirm a reminder is sent; advance past the deadline
and confirm the fallback transition fires; in a second run, respond before the
deadline and confirm the run resumes on the approval branch. Verify both `quorum`
modes for a multi-holder role.

**Acceptance Scenarios**:

1. **Given** a human step, **When** the run reaches it, **Then** the addressed
   principal is notified on the configured channel and a durable await is created in
   the `waiting` state.
2. **Given** a pending await with a reminder interval, **When** the interval elapses
   with no response, **Then** a reminder is sent (re-resolving a role to its *current*
   holder), bounded so reminders stop once the await is resolved.
3. **Given** a pending await with a deadline, **When** the deadline passes with no
   qualifying response, **Then** the Conductor fires the step's declared in-graph
   fallback transition and the await is closed as `timed_out`.
4. **Given** a human response that arrives, **When** it is recorded, **Then** the run
   resumes; a late response arriving after the deadline/resolution is rejected and
   logged, never double-advancing the run.
5. **Given** a role-addressed step with `quorum: all`, **When** responses arrive,
   **Then** the step completes only after every current holder has responded; with
   `quorum: any` the first qualifying response completes it.

---

### User Story 6 - Principals & the Role Resolver Seam (the "baton") (Priority: P1)

A workflow step addresses a **principal**: either `user:<id>` (a specific person, who
may be any omadia user of the instance, not only the workflow's creator) or
`role:<key>` (a named seat). A role is resolved to its current holder(s) **at dispatch
time and re-resolved on every reminder**, through a pluggable `RoleResolver`. Per
**#333 (Identity & Role Projection)**, the **primary** resolver projects role holders
from the organization's systems of record (an IdP such as Entra via groups/app-roles,
and/or an HR/ERP source such as Odoo), correlated to omadia users on a primary key.
omadia's **local** manual assignment store is the **default / stand-alone fallback**
(used when no external source is configured; the baton is then moved by an API/Designer
action). Conductor only ever calls the resolver and hard-codes no role semantics. Access
to a pending await and its payload is granted to whoever holds the role **at access
time** — when the baton moves, access moves with it.

**Why this priority**: Addressing a fixed person is brittle (people change roles, go
on leave). The role indirection is required for the operator's real processes and must
be in the data model from the start, not retrofitted.

**Independent Test**: Define `role:approver`; assign it to user A; start a run that
addresses `role:approver`; confirm A is notified and can see/answer the await; move the
baton to user B; confirm the next reminder targets B, that B can now see/answer the
await, and that A no longer can; with no holder assigned, confirm the step takes the
fallback transition.

**Acceptance Scenarios**:

1. **Given** a step addressing `user:<id>`, **When** the run reaches it, **Then** that
   specific omadia user is the addressed principal regardless of who started the run.
2. **Given** a step addressing `role:<key>`, **When** the step dispatches, **Then** the
   holder is resolved live via the `RoleResolver`; the registered resolver (default:
   manual store) determines the result and Conductor hard-codes no role semantics.
3. **Given** a pending await for a role, **When** the baton moves to a new holder,
   **Then** the new holder gains access to the await and its payload and the previous
   holder loses it, resolved at access time — not frozen to a user id.
4. **Given** a role with no current holder (or all holders reported unavailable with no
   delegate), **When** the step dispatches or a reminder is due, **Then** it is treated
   as an unmet postcondition and the fallback transition fires — reusing the same
   harness, no special-casing.
5. **Given** a baton move, **When** it occurs, **Then** a `role.assignment.changed`
   event and an `await.reassigned` event are emitted for audit and for any external
   subscriber.

---

### User Story 7 - Conductor Designer: Visual & Conversational Co-Design (Priority: P2)

An operator opens the Conductor Designer, designs a workflow in conversation with a
builder agent and on a visual flow diagram (the same UX as the Agent Builder, applied
to the collaboration *between* Agents), and saves it. Saved workflows can be reopened
and updated; saves are versioned so a later edit does not silently mutate the
definition a running release depends on.

**Why this priority**: The capability is usable via API/config once US1–US6 land; the
Designer is the ergonomics layer that makes it a product. It is high value but depends
on the engine and the catalog existing first — the same sequencing the Agent Builder's
Operator UI followed.

**Independent Test**: Use the Designer to build a workflow with a trigger, an agentic
step, and a human step with a role and a deadline fallback; save it; confirm it
validates and persists; reopen it, change the reminder interval, save again, and
confirm a new version is recorded while a run started on the prior version is
unaffected.

**Acceptance Scenarios**:

1. **Given** the Designer canvas, **When** the operator adds steps, transitions, and a
   trigger and wires them, **Then** the visual graph and the persisted workflow
   definition stay in sync via the same optimistic-mutation-with-rollback pattern the
   Agent Builder uses.
2. **Given** the builder agent, **When** the operator describes a process in chat,
   **Then** the agent mutates the workflow definition incrementally (create step, wire
   transition, set postcondition, add human step) and the canvas reflects each change.
3. **Given** installed connectors, **When** the operator picks a trigger, **Then** the
   Designer offers the event catalog's events with their payload fields available for
   filters/branches (field autocomplete from the declared schema).
4. **Given** a saved workflow, **When** the operator edits and re-saves it, **Then** a
   new version is recorded and runs already in flight continue on the version they
   started with.
5. **Given** an invalid workflow (unreachable step, missing fallback on a deadline,
   unknown role), **When** the operator tries to save/activate it, **Then** validation
   blocks it and names the failing check.

---

### User Story 8 - Workflow Dry-Run / Preview (Priority: P2)

Before activating a workflow, the operator runs it in a preview mode that simulates the
multi-agent path and lets the operator stand in for human steps, without notifying real
users or performing irreversible connector actions.

**Why this priority**: Mirrors the Agent Builder's preview value — confidence before
go-live — but for a process. Multi-agent preview is net-new (the single-agent
`previewRuntime` does not cover it), so it is its own story, not a reuse.

**Independent Test**: Dry-run a workflow with one agentic and one human step; confirm
the agentic step executes against preview-scoped tools, the human step prompts the
operator inline (no real channel notification, no durable await against a real user),
and the simulated path matches the engine's deterministic decisions.

**Acceptance Scenarios**:

1. **Given** dry-run mode, **When** a run executes, **Then** human steps are answered
   inline by the operator and no real notification, reminder, or durable await against
   a real user is created.
2. **Given** dry-run mode, **When** a step would call a connector action flagged
   irreversible, **Then** it is simulated/stubbed rather than executed.
3. **Given** a dry-run, **When** it completes, **Then** the operator sees the full step
   path, each step's postcondition outcome, and where fallbacks would have fired.

---

### User Story 9 - Run Audit & Observability (Priority: P3)

Every run produces an auditable trace: which trigger started it, each step with its
actor (Agent or resolved human principal), each postcondition outcome, each transition
taken (including fallbacks), every reminder sent, and every baton resolution. This
plugs into omadia's existing per-run trace / call-stack viewer.

**Why this priority**: Auditability is a core omadia promise and a selling point over
prompt-only frameworks, but the run is functional without the viewer; this is the
observability layer on top.

**Independent Test**: Run a workflow that takes a fallback transition and sends a
reminder; open the run trace; confirm the trigger, every step, the postcondition
verdicts, the reminder, the resolved human principal, and the fallback transition are
all present and ordered.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** its trace is opened, **Then** it shows the
   trigger, the ordered step path, each actor, each postcondition outcome, and each
   transition (including fallbacks).
2. **Given** a human step, **When** its trace entry is inspected, **Then** it records
   the addressed principal, the *resolved* holder at dispatch, any reminders, and the
   final response or timeout.
3. **Given** an event-triggered run, **When** its trace is inspected, **Then** the
   originating event id, source connector, and (redaction-respecting) payload are
   recorded.

---

### Edge Cases

- **Process restart mid-wait**: the run stays `waiting`; the timer for reminders/
  deadline is re-derived from persisted timestamps on boot, not from an in-memory
  timer (US2).
- **Deadline fires while a response is in flight**: resolution is atomic — the first of
  {qualifying response, deadline} wins; the loser is rejected and logged, the run never
  double-advances (US5).
- **Reminder after resolution**: reminders are bounded by the await state; once
  `resolved`/`timed_out`, no further reminder is sent (US5).
- **Baton moves mid-wait**: the next reminder re-resolves and targets the new holder;
  access to the await follows the current holder at access time (US6).
- **Role with no holder / all unavailable**: treated as an unmet postcondition → the
  fallback transition fires; no silent hang (US6).
- **`quorum: all` and a holder leaves the role mid-wait**: the required set is the
  holders current *at completion check* time; a departed holder's outstanding
  obligation is dropped, a newly added holder's is added — re-resolved, not frozen
  (US5/US6).
- **Connector uninstalled while a run is subscribed/waiting on its events**: the
  workflow surfaces a "trigger source missing" diagnostic; in-flight runs already
  started are unaffected (US4).
- **Event payload schema changes between connector versions**: the catalog records the
  schema version; an emit is validated against the installed version; a subscribed
  workflow referencing a now-absent field surfaces a validation diagnostic in the
  Designer (US4).
- **Cyclic graph / unreachable step / deadline step with no fallback**: rejected at
  workflow validation time, in the Designer and on activation (US1/US7).
- **Workflow edited while runs are in flight**: in-flight runs continue on their
  started version; only new runs use the new version (US7).
- **Two triggers fire for the same workflow near-simultaneously**: each produces an
  independent run; runs do not share mutable state.
- **Human step targets a user who has no binding on the configured channel**: the await
  is created but flagged "principal unreachable on channel"; per configuration this
  either escalates via the fallback or surfaces an operator diagnostic — never a silent
  no-op.
- **Agentic step stalls (LLM ends without satisfying the postcondition)**: the
  Conductor applies the existing tool-obligation/repeat-failure guards at step scope
  and, if still unmet, fires the fallback — the harness on track (US1).

## Requirements *(mandatory)*

### Functional Requirements

**Engine & runs**

- **FR-001**: The system MUST provide a pure, I/O-free engine package
  (`@omadia/conductor-core`) that models a Workflow as steps + guarded transitions and,
  given a completed step's result, deterministically selects the next step or the
  step's declared fallback.
- **FR-002**: The engine MUST evaluate a completed step's **exit postcondition** and
  MUST NOT advance on a happy-path transition when the postcondition is unmet; it MUST
  instead select the step's fallback transition, or raise a precise error if none is
  declared.
- **FR-003**: Workflow validation MUST reject unreachable steps, unguarded cycles, a
  deadline-bearing human step without a fallback transition, and references to unknown
  roles, events, agents, or actions — naming the offending node.
- **FR-004**: A workflow **run** MUST be persisted such that each completed step and the
  run's accumulated context are durable before the next step begins, and a `waiting`
  run MUST survive a process restart and resume without re-executing or skipping a step.
- **FR-005**: A step that throws or exceeds its time budget MUST drive the run to a
  recorded `failed`/fallback state per the graph — never an unrecorded hang.
- **FR-006**: The engine MUST be deterministic: identical workflow + identical sequence
  of step results MUST yield the identical step path.

**Triggers**

- **FR-007**: All trigger types MUST funnel into a single `startRun(workflowId,
  payload)` entry point, and the trigger payload MUST become the run's initial context.
- **FR-008**: The system MUST support, as start triggers, at minimum: manual
  (UI/API), cron (reusing `scheduleWorker`/`agent_schedules`), inbound channel message,
  an Agent-invoked `start_workflow` tool, an external webhook, and workflow→workflow.
- **FR-009**: A trigger that fires for a disabled or non-existent workflow MUST start no
  run and MUST be logged — never silently dropped.

**Event triggers / Conductor Surface**

- **FR-010**: The plugin `manifest.yaml` MUST be extendable with an `emits:` block in
  which a connector declares events it can emit — each with a stable `id`, a human
  label, and a payload JSON Schema. This is a sibling of the existing `provides:` block;
  no parallel manifest format is introduced.
- **FR-011**: On install/activation the kernel MUST autodiscover declared `emits:`
  entries into an event catalog (the "declare → resolve → derive" pattern, provided via
  `serviceRegistry`), and MUST remove them on uninstall/hot-unload.
- **FR-012**: The kernel MUST expose `ctx.events.emit(id, payload)`, gated by a manifest
  permission (`permissions.events.emit`, deny-by-default), and MUST validate the payload
  against the declared schema, rejecting and logging a non-conforming emit so no run
  starts on malformed data.
- **FR-013**: A workflow event trigger MUST be able to name an event `id` plus an
  optional filter over payload fields; a matching emit MUST start a run with the
  validated payload as initial context; a non-matching emit MUST start no run.
- **FR-014**: The system MUST expose the catalog such that, after a connector is
  installed, an operator can see which events (triggers) and which actions a connector
  makes available to the Conductor — and the absence of `emits:` MUST be presented as
  clearly as its presence.

**Human steps & awaits**

- **FR-015**: A human step MUST create a **durable** pending await (surviving process
  restart) carrying its addressed principal, channel, message, reminder interval,
  optional deadline, fallback transition reference, `quorum`, and status.
- **FR-016**: The system MUST notify the addressed principal on the configured channel
  using the existing proactive-send mechanism, and MUST send reminders at the configured
  interval until the await is resolved or timed out.
- **FR-017**: When a deadline passes with no qualifying response, the system MUST fire
  the human step's **in-graph fallback transition** (not a separate sub-workflow) and
  close the await as `timed_out`.
- **FR-018**: Await resolution MUST be atomic between a qualifying response and the
  deadline; a response arriving after resolution/timeout MUST be rejected and logged,
  never double-advancing the run.
- **FR-019**: A human step MUST support `quorum: any | all` (default `any`); `all` MUST
  complete only when every *current* holder of the addressed role has responded, with
  the required set re-resolved (not frozen) at the completion check.

**Principals & roles**

- **FR-020**: A human step MUST address a **principal** that is either `user:<id>` (any
  omadia user of the instance, not only the run's initiator) or `role:<key>`. Per the
  platform-wide paradigm in **#333**, `Principal = user | role` is the **default**
  addressee type for *every* surface that targets a person (human steps, escalation /
  fallback targets, report and interim-status recipients, notifications, assignments).
  Restricting a surface to **user-only** is the exception, permitted only when
  technically or legally necessary to bind one named natural person, and MUST carry a
  documented justification (mirroring the `multi_instance_justification` precedent).
- **FR-021**: A `role:<key>` MUST be resolved to its current holder(s) via a pluggable
  `RoleResolver` registered through `serviceRegistry` (the same seam pattern as
  `LlmProvider`/channels); Conductor MUST hard-code no role semantics. The **primary**
  resolver MUST project holders from external systems of record per **#333 (Identity &
  Role Projection)** — an IdP (Entra groups/app-roles) and/or an HR/ERP source —
  correlated to omadia users on a primary key. A **local** manual assignment store MUST
  exist as the **default / stand-alone fallback** (with APIs to move the baton) for
  deployments that configure no external source; the local table MUST NOT be treated as
  the long-term system of record.
- **FR-022**: Role resolution MUST be **late-bound**: performed at step dispatch and
  re-performed on each reminder, so a baton that moves before or during a wait routes to
  the current holder.
- **FR-023**: Access to a pending await and its payload MUST be authorized against the
  role's holder **at access time**; when the baton moves, the new holder gains access
  and the previous holder loses it.
- **FR-024**: A role with no current holder (or all holders reported unavailable with no
  delegate) MUST be treated as an unmet postcondition and fire the fallback transition.
- **FR-025**: Baton moves and await reassignments MUST emit `role.assignment.changed`
  and `await.reassigned` events for audit and external subscription.

**Designer**

- **FR-026**: The system MUST provide a Conductor Designer under
  `web-ui/app/admin/conductor/` that lets an operator build a workflow visually (a flow
  diagram reusing the Agent Builder's React-Flow canvas, optimistic-mutation, and REST
  patterns) and conversationally (a builder agent that incrementally mutates the
  workflow definition).
- **FR-027**: The Designer MUST persist workflows with **versioning**; editing and
  re-saving a workflow MUST create a new version and MUST NOT alter the definition used
  by runs already in flight.
- **FR-028**: The Designer MUST source trigger options from the live event catalog and
  MUST offer payload fields (from the declared schema) for filters and branch
  conditions; it MUST block save/activation of an invalid workflow, naming the failing
  check.

**Preview & audit**

- **FR-029**: The system MUST provide a dry-run/preview mode in which human steps are
  answered inline by the operator (no real notification, reminder, or durable await
  against a real user) and connector actions flagged irreversible are simulated.
- **FR-030**: Every run MUST emit a structured, auditable trace — trigger, ordered step
  path, each actor (Agent or resolved human holder), each postcondition outcome, each
  transition (including fallbacks), reminders, and baton resolutions — integrating with
  omadia's existing per-run trace viewer and respecting existing redaction.

**Architecture & reuse**

- **FR-031**: Conductor MUST reuse the existing platform primitives rather than
  duplicate them: orchestrator/sub-agent loop and its postcondition/obligation guards,
  `scheduleWorker` for time-driven signals, the channel registry + proactive sender for
  notifications, the user store for principals, and the verifier — extended, not
  replaced.
- **FR-032**: The engine (`@omadia/conductor-core`) MUST be pure and I/O-free; all
  persistence, scheduling, notification, and LLM I/O MUST live in kernel wiring outside
  the engine package, so the engine is unit-testable in isolation.

### Key Entities

- **Workflow**: a named, versioned process definition — a graph of steps + guarded
  transitions + one or more triggers. Identified by a slug; immutable per version.
- **Workflow Version**: an immutable snapshot of a workflow's graph; runs bind to the
  version they start on.
- **Step**: a node of kind `agent` (an Agent turn), `action` (a deterministic action),
  or `human` (a human step). Carries an exit postcondition and a fallback transition
  reference.
- **Transition**: a guarded directed edge from one step to another; the guard is
  evaluated against the source step's result/context. A step's fallback is a designated
  transition.
- **Trigger**: a run starter bound to a workflow — kind `manual | cron | channel |
  agent | webhook | workflow | event`. An `event` trigger names a catalog event id + an
  optional payload filter.
- **Run**: a live or completed execution of a Workflow Version — state, current step,
  accumulated context, audit trace. States include `running | waiting | completed |
  failed`.
- **Await (`conductor_awaits`)**: a durable pending human action for a run's human step
  — addressed principal, channel, message, reminder interval, optional deadline,
  fallback reference, `quorum`, status (`waiting | resolved | timed_out | cancelled`),
  recorded response.
- **Principal**: the addressee of a human step — `user:<id>` or `role:<key>`.
- **Role**: a named seat (`key`, label, scope) addressable by a human step.
- **Role Assignment**: the binding of a role to current holder principal(s) — the baton;
  provenance (`manual | resolver:<id>`), validity window, optional delegate.
- **Role Resolver**: a registered provider that resolves a role key to current
  holder(s) and availability; default is the manual-assignment-backed resolver.
- **Event Catalog Entry**: a declared connector event — id, source plugin, label,
  payload JSON Schema (versioned) — autodiscovered from a connector's `emits:` block.
- **Conductor Surface**: a connector's declared interaction set with the Conductor —
  its `emits:` events (triggers) plus its `provides:` actions — surfaced in the Designer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can build, save, and run a workflow that combines at least one
  agentic step and at least one human step, end to end, without writing code.
- **SC-002**: A workflow run that is waiting on a human step survives a middleware
  process restart and resumes correctly when the human responds — verified by an
  automated restart test (no step re-executed, none skipped).
- **SC-003**: A human step with a reminder interval and a deadline sends the reminder at
  the interval and fires the in-graph fallback at the deadline, in 100% of no-response
  cases — verified by a clock-driven automated test for both `quorum: any` and `all`.
- **SC-004**: After installing a fixture connector that declares `emits:`, the declared
  events appear in the catalog and are selectable as triggers in the Designer with their
  payload fields available — with zero manual wiring.
- **SC-005**: An emit whose payload violates the declared schema starts no run and is
  logged with a precise error — verified by an automated test.
- **SC-006**: Moving a role's baton from holder A to holder B causes the next reminder
  to target B and transfers await access from A to B, resolved at access time —
  verified by an automated test; A can no longer read the await, B can.
- **SC-007**: A role with no current holder causes the human step to take its fallback
  transition rather than hang — verified by an automated test.
- **SC-008**: Editing and re-saving a workflow creates a new version while a run started
  on the prior version completes unchanged — verified by an automated test.
- **SC-009**: The deterministic engine produces an identical step path for identical
  inputs across repeated runs — verified by a property/fixture test in
  `@omadia/conductor-core` with no I/O.
- **SC-010**: A completed run's trace contains the trigger, every step with its actor,
  every postcondition outcome, every transition (including fallbacks), reminders, and
  baton resolutions.

## Assumptions

- Conductor ships **in this repo, modular**: `@omadia/conductor-core` (pure engine) +
  kernel wiring in `middleware/src/` via the existing `serviceRegistry` + a Designer
  under `web-ui/app/admin/conductor/`. No separate repository; only an HR/ERP role
  resolver is expected to live in a separate, swappable connector plugin.
- The existing primitives are reused as-is and extended, not replaced: the orchestrator
  / sub-agent loop and its postcondition, tool-obligation, and repeat-failure guards;
  the `scheduleWorker` cron scheduler (minute granularity, DB-durable, single-process);
  the channel registry + proactive sender; the user store; the verifier; the Agent
  Builder's canvas, builder-agent, and REST patterns.
- Connector plugins (GitHub/CI, ATS/HR, calendar, ERP, …) are separate plugin work.
  Conductor defines and depends only on the *contract* (`emits:` / `provides:` / the
  event catalog / `ctx.events.emit`), never on a specific connector.
- Roles and user identities are **projected from the organization's systems of record**
  per **#333 (Identity & Role Projection)** — an IdP (Entra) for access identity, an
  HR/ERP source for org roles/attributes — joined on a primary key; omadia maintains no
  user/role master copy except in the stand-alone fallback. The HR/ERP role-movement
  *policy* (when/why a baton moves) is owned by the live instance and its integration;
  Conductor provides the resolver seam and consumes the projection, exposing state/data
  access scoped to the current holder so any integration can drive movement.
- A human principal is reachable proactively on a channel only if a channel binding /
  conversation reference for that user exists; provisioning those bindings is an
  operational concern reusing existing channel mechanisms.
- The existing Postgres (Neon) instance is available for workflow, run, await, role, and
  catalog storage and supports `LISTEN/NOTIFY` for run resume on human response.
- The reminder/deadline timing granularity inherits the scheduler's minute-level
  resolution, which is sufficient for human-response cadences (hours/days).
- `deterministic_action`, postconditions, and the verifier already exist at tool/turn
  scope; this feature promotes their use to process scope and does not redefine them.
