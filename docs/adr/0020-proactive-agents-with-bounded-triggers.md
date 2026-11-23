# 0020 — Proactive agents through bounded triggers, no heartbeats

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** the facilitation pattern's hourly model tick

## Context and Problem Statement

A colleague who notices something but only speaks when asked is of little use. Today
proactivity exists only in unbounded pieces: routines are user-owned recurring cron jobs
without end date or cost cap; plugin jobs run until deactivation and keep ticking after
failures; Conductor triggers are operator-authored. An agent cannot wake itself or
subscribe to an event, and no model spend cap exists. Fixed heartbeats would burn
resources around the clock and can cost thousands when something goes wrong.

How do agents act unasked without any trigger ever running on blindly?

## Decision Drivers

- Agents decide themselves, from context, when to watch or wake (INV-10).
- Every trigger has a deadline, limits and a budget enforced deterministically.
- Most firings should never reach a model.
- Survive restarts; fire each occurrence at most once.

## Considered Options

- **A — Agent-owned hooks, wakeups and timers with harness-enforced bounds**
- **B — Fixed heartbeat per agent** (periodic model turn: "anything to do?")
- **C — Operator-authored triggers only** (Conductor, routines)

## Decision Outcome

Chosen option: **A**.

- **Three trigger kinds**, created by the agent through harness tools:
  `on_event(filter, purpose, context, until, max_fires)` (preferred wherever an event
  exists), `wake_at(time, purpose, context, until)` (one-shot),
  `wake_every(interval, purpose, context, until, max_runs)` (recurring only while needed).
  An event-source catalogue lists what the agent's channels and capabilities offer; events
  flow over the Conductor event bus.
- **Action types, cheapest first:** `check`, `post` (template), `deliver` (side channel) run
  without a model; `turn` only where judgement or language is needed. Triggers chain them.
- **Harness guarantees** (not overridable by prompt or plugin): mandatory `until` within
  instance caps; `max_runs` for recurring; bound to a context that ends it; minimum
  intervals and a maximum of active triggers per agent; cost caps per firing, per trigger,
  monthly per agent and per instance, checked before each firing; instance-wide kill
  switch; deterministic pre-check before any model call; circuit breaker on consecutive
  failures or ineffective turns (a check finding nothing is a success); durable, leased,
  at-most-once per occurrence with delivery classes (droppable vs essential).
- **Same rules as any turn:** the agent's envelope, the discretion labels of the creating
  context, recipient grants, communication profile, quiet hours, per-recipient rate limit.
- **Visible:** operators see every active trigger with purpose, deadline and cost; users can
  ask an agent what it is watching; every creation, firing and end is audited.
- **Existing mechanisms:** routines become user-requested triggers and keep their human
  ownership, controls and cron semantics; plugin jobs stay for maintenance, never call a
  generative model, and back off with bounded recovery probes; Conductor triggers stay for
  operator processes; learning and consolidation become bounded batch triggers of the
  memory's owner agent. **No fixed heartbeats anywhere.**

### Consequences

- 🟢 **Good:** Agents can be genuinely proactive (month-end reminders, meeting time-keeping,
  watching an approval) at predictable cost.
- 🟢 **Good:** One bounded mechanism replaces several unbounded ones.
- 🔴 **Bad:** New durable scheduler with leases, budgets and an operator view.
- ⚪ **Neutral:** Issue #2082 (absorbs the communication-profile research of #1035);
  acceptance criteria 20 to 24, 26, 32. The facilitator's plugin scheduler runs under
  execution scopes and can move onto these triggers later
  ([ADR-0022](0022-native-facilitators-as-an-archetype-plugin.md)).

## Pros and Cons of the Options

### A — Bounded agent-owned triggers

- 🟢 Proactive and safe; most firings model-free.
- 🔴 Significant kernel work.

### B — Heartbeats

- 🟢 Trivial to build.
- 🔴 Constant spend, no context, runaway risk.

### C — Operator-only triggers

- 🟢 Fully controlled.
- 🔴 Agents cannot react to what they notice; not a colleague.

## More Information

- Spec INV-10; §5.12; terminology "Proactivity".
- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md).
