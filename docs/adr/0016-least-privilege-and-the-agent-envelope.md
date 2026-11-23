# 0016 — Least privilege by default; everything inside one agent's envelope

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** auto-attach of plugins to the default agent (#1491, #1498)

## Context and Problem Statement

First boot and every later install path attach every attachable plugin to the default
agent, which also receives all unbound traffic. Whoever reaches that agent holds the
master key to every connected third-party system. At the same time several mechanisms run
"inside" an agent (DB sub-agents, persona skills, fast path) and some of them present
themselves to users as if they were someone else.

What may an agent use, how is that set, and what may run inside one agent's turn?

## Decision Drivers

- Pilot customers connect real ERP, CRM, HR and mail systems; a super-agent out of the box
  is unacceptable.
- Operators must see each agent's reach at a glance.
- Internal optimisations (cheaper models, isolated context, no full loop for simple data
  questions) are valuable and must be kept.
- Nothing inside an agent may speak as someone else or use more than the agent may.

## Considered Options

- **A — No auto-attach; explicit grants; one envelope per agent; helpers inside it**
- **B — Auto-attach with an opt-out per plugin**
- **C — Role-based bundles** (predefined "admin", "sales" agent profiles with broad grants)

## Decision Outcome

Chosen option: **A**.

- **Envelope** ("no more, no less", INV-2): identity, instructions, personality,
  boundaries, model policy, skills, capability grants and memory scope, capped by the
  audience's rights. Every path that answers for an agent (including deterministic ones)
  renders under its identity, boundaries and AI disclosure.
- **No auto-attach.** Installing a capability plugin offers to grant it to agents the
  operator picks; nothing is granted without that choice. No instance ships an agent with
  access to every connected system; onboarding creates the first agent with an explicit
  choice of capabilities.
- **Reach** (every system an agent can read or write, read/write separated) is shown on the
  agent page and in the directory. Granting all-system access or making such an agent a
  default needs explicit confirmation and is audited.
- **Audience provider on by default** (G15): the audience floor is always active.
- **Internal helpers** run strictly inside the agent's envelope (same or narrower grants and
  memory scope, a model the agent's policy allows, the agent's budget), have no name
  towards people, and appear in the trace as the agent's own work:
  - **DB sub-agents** (`agent_subagents`) → internal helpers; never listed as consulted
    agents; Agent Builder canvas node "helper".
  - **Persona skills** → **working modes**: per-turn selection kept, the skill loads
    beneath the fixed identity; UI says "mode: X", never "answering as X".
  - **Fast path** → the agent's **fast lane**: agent fixed first, planner, learned plans
    and cache as its helpers, answer under its identity, per-agent switch, boundary check
    before a data action runs.
- Anything that needs another envelope is a consultation
  ([ADR-0018](0018-consultation-instead-of-delegation.md)).

### Consequences

- 🟢 **Good:** The blast radius of one compromised conversation is one agent's grants.
- 🟢 **Good:** Cost and context isolation of helpers and the fast lane survive.
- 🔴 **Bad:** More setup for operators: every capability is a deliberate grant.
- ⚪ **Neutral:** Issues #2054, #2048, #2050, #2051, #1876; acceptance criteria 6, 9, 11,
  28, 35.

## Pros and Cons of the Options

### A — Explicit grants, one envelope

- 🟢 Least privilege is the default, not a hardening step.
- 🔴 Onboarding must guide the first grants well.

### B — Auto-attach with opt-out

- 🟢 Convenient demos.
- 🔴 Every forgotten opt-out is a master key.

### C — Role bundles

- 🟢 Faster setup.
- 🔴 Bundles drift toward broad access; reach becomes implicit again.

## More Information

- Spec INV-2, INV-8; §5.2, §5.6, §5.7, §5.13 (boundary check 1a).
- Related: [ADR-0012](0012-agents-are-virtual-employees.md),
  [ADR-0019](0019-discretion-as-information-flow-control.md).
