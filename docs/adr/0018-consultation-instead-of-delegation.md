# 0018 — Consultation instead of delegation between agents

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** hidden delegation to sub-agents and `delegatedAnswer` (#332)

## Context and Problem Statement

Today an agent delegates to hidden sub-agents that run without identity and with the
parent's scope. Agent-to-agent has a per-agent switch (`agents.agent_to_agent`) and a
per-conversation policy (`agent_channel_policies`), but neither names a target agent, so
neither is a permission for A to ask B. A consulted agent could hand A data that A may not
see itself.

How may agents work together as colleagues without widening anyone's access?

## Decision Drivers

- Asking a colleague adds skill and judgement, **never access**.
- Collaboration must be visible: B's words reach people attributed to B, unaltered.
- Off by default; explicitly configured per agent and per pair.
- One authorization model for every agent-to-agent path.

## Considered Options

- **A — Directed consultation grants; access = intersection; contributions delivered by the harness**
- **B — Free delegation with B's full access**
- **C — No agent-to-agent communication at all**

## Decision Outcome

Chosen option: **A**.

- **Switches:** `consultable` and `may_consult` per agent, both default off.
- **Directed grants** `agent_consultation_grants (from_agent_id, to_agent_id,
  channel_scope, allowed_capabilities, memory_access, max_calls_per_turn,
  max_calls_per_day, …)`: operator-managed, audited on both agents, revocable on the next
  call. `allowed_capabilities` defaults to none; `memory_access` is `none` (default) or
  `discreet` ([ADR-0019](0019-discretion-as-information-flow-control.md)). Facilitators can
  neither hold nor be the target of a grant.
- **Flow:** harness tool `consult(agent, request)`; depth max. 1, per-turn budget, timeout.
  B runs with its own identity, instructions, skills and model; its **data access is the
  intersection** of the grant's allowed capabilities, B's grants, **A's grants** and the
  audience's rights. B writes nothing to its memory from a consultation.
- **Two views:** a user view (privacy-shield restored, audience-checked) delivered as B's
  contribution, and a masked model view for A.
- **Delivery:** `SemanticAnswer.contributions: [{ id, speaker, text, status }]` replaces
  `delegatedAnswer`. B's own identity posts it where present, otherwise A's message carries
  it with a plain attribution. A cannot remove or rewrite it and refers to it only by id.
  A failed delivery is shown as failed.
- **Audience floor required:** without an active audience provider the consultation is
  refused with a `system` notice.
- **One authorization:** consultation, Conductor discussions (`discussion_start`, `say`) and
  any relay need the same directed grants (both directions for a discussion), in addition
  to the existing per-agent switch and per-conversation policy. All three must allow it.
- `agentsConsulted` stays as trace summary. Cost of B's run is recorded against B and
  linked to A's turn.

### Consequences

- 🟢 **Good:** Teams of agents can collaborate without any agent becoming a data back door.
- 🟢 **Good:** The user can always address B directly instead.
- 🔴 **Bad:** Intersection semantics make some consultations less useful than free
  delegation would be; that is intended.
- 🔴 **Bad:** Depends on discretion labels and the audience provider being in place.
- ⚪ **Neutral:** Issue #2047; acceptance criteria 3, 4, 13.

## Pros and Cons of the Options

### A — Directed grants, intersection

- 🟢 Safe by construction, visible, auditable.
- 🔴 More configuration and a new contract (`contributions[]`, model view).

### B — Free delegation

- 🟢 Maximally useful answers.
- 🔴 Any agent reaches any data through a colleague; hidden intermediary again.

### C — No agent-to-agent

- 🟢 Simplest and safest.
- 🔴 Loses the team effect that makes virtual employees worth having.

## More Information

- Spec INV-5; §5.4; terminology "Working together".
- Related: [ADR-0013](0013-speaker-stamping-and-identity-guard.md),
  [ADR-0016](0016-least-privilege-and-the-agent-envelope.md).
