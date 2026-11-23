# 0012 — Agents are virtual employees; no orchestrator agent

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** the orchestrator-owns-every-turn model of #332 (never recorded as an ADR)

## Context and Problem Statement

omadia grew up around one "orchestrator" agent that received every turn and delegated
to hidden specialists (`query_<short>` tools of Builder-generated agent plugins, DB
sub-agents, persona skills that swapped the identity per turn, Direct Line `#token`
addressing patched on top). In the beta a user worked with a Builder-created
"Strategist", and the orchestrator answered in its place without ever calling it.

Pilot customers expect to work with named colleagues whose permissions they can audit.
What is the unit a person talks to, and who decides which unit answers?

## Decision Drivers

- A person who addresses an agent must get exactly that agent: its identity,
  personality, capabilities, permissions and memory, no more and no less.
- Who answers must be decided deterministically, never by a model.
- Failures must be visible; a silent substitute erodes trust faster than an error.
- omadia is a team-first AI OS: several agents in one team, each accountable.
- There are no customer installations yet, so the change can be made cleanly now.

## Considered Options

- **A — Agents as virtual employees under a deterministic management layer**
- **B — Keep the orchestrator, add guards** (identity checks, better delegation footers)
- **C — Orchestrator per team** (one routing agent per channel or team)

## Decision Outcome

Chosen option: **A**, because only A makes "who answers" a property of routing instead
of model behaviour. Normative detail lives in
[`specs/2042-agents-as-virtual-employees/spec.md`](../../specs/2042-agents-as-virtual-employees/spec.md)
(invariants INV-1 to INV-11, §5); the binding vocabulary in
[`docs/terminology.md`](../terminology.md).

The decision in short:

1. **The agent is the only actor.** An agent is a virtual colleague with identity,
   personality, instructions, boundaries, model policy, capability grants, memory tree
   and channel identities. Only agents and `system` speak to people.
2. **No orchestrator agent.** Below the agents runs the **management layer**
   (routing, identity, permissions, discretion, privacy shield, scheduling, audit,
   Conductor). It never answers, has no persona and never uses a model to choose who
   answers. "Orchestrator" is retired as a product term; it survives only as the code
   name of the agent runtime package (`harness-orchestrator`).
3. **Deterministic routing order** (INV-1, spec §5.6): explicit addressing (own channel
   identity, mention, explicit selection, API slug) → the user's stored selection for the
   conversation → the conversation's binding → the **default-agent table**
   ((user, channel), (user), (channel), instance; first existing entry wins, each entry
   names an agent or is `off`) → `system` notice. A fresh instance starts with the
   instance entry `off`.
4. **Availability** (who may use an agent, in which channels) is checked before every
   turn, including explicit addressing. A fresh agent is available to nobody.
5. **Fail loud** (INV-7): a disabled, deleted, unavailable or failing agent produces a
   `system` notice naming the agent and the reason. No silent fallback, ever. Deleting
   an agent keeps a tombstone so bindings keep pointing at it.
6. **Removed:** Direct Line (`#token`, sticky mode), the fallback agent's special role
   and its seeding as "Standard Orchestrator", the delegating default identity text.
7. **Kept in adapted form** (rule: purpose first, then conflict, then an adaptation that
   keeps the advantage): DB sub-agents become **internal helpers**, persona skills become
   **working modes**, the fast path becomes the agent's **fast lane**
   ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).

### Consequences

- 🟢 **Good:** The "Strategist" class of incident is impossible by construction: a turn
  addressed to A runs in A's envelope or produces a `system` notice.
- 🟢 **Good:** Every answer is attributable to one accountable agent
  ([ADR-0013](0013-speaker-stamping-and-identity-guard.md)).
- 🟢 **Good:** Teams already has one bot per agent (#860), per-agent identities (#914) and
  per-agent model policy and grants; the model builds on what holds.
- 🔴 **Bad:** Users who relied on "ask the one bot anything" must now know which colleague
  to address, or an operator must configure default agents.
- 🔴 **Bad:** Large rewrite of routing, prompt assembly, onboarding and every UI that
  said "Orchestrator".
- ⚪ **Neutral:** Work breakdown in epic #2042 (spec §8, 25 items); acceptance is the
  40 criteria of spec §6.

## Pros and Cons of the Options

### A — Agents as virtual employees

- 🟢 Speaker and envelope follow from routing; no model can change them.
- 🟢 Matches how teams already work with colleagues and how auditors think.
- 🔴 Needs an explicit default-agent configuration per instance.

### B — Keep the orchestrator, add guards

- 🟢 Least code churn.
- 🔴 A hidden intermediary stays; guards can only detect impersonation after a model
  produced it.
- 🔴 The orchestrator stays a super-agent with every plugin attached
  ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).

### C — Orchestrator per team

- 🟢 Smaller blast radius than one global orchestrator.
- 🔴 Same hidden-intermediary problem per team; a model still picks who answers.

## More Information

- Spec: `specs/2042-agents-as-virtual-employees/spec.md` (PR #2044, revised #2081,
  #2099–#2102). Terminology: `docs/terminology.md`.
- Epic #2042; related issues #2045, #2052, #2055, #2056, #2057, #1880.
- Migration rule (spec §7): no compatibility layers, deprecation periods or upgrade paths
  for customers, because none exist yet. On instances byte5 runs live (Fly, Azure),
  schema changes still ship expand/contract so a running machine is never broken
  mid-deploy (precedent: `agents.kind` next to `agents.archetype` until the contract
  step, [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md)).
- Related: [ADR-0013](0013-speaker-stamping-and-identity-guard.md) to
  [ADR-0022](0022-native-facilitators-as-an-archetype-plugin.md) together form the agent
  model; new work conforms to them or supersedes one with a new ADR.
