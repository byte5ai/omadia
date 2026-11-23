# 0022 — Native facilitators: an archetype delivered by an archetype plugin

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** the `facilitation` Conductor pattern with its hourly model tick, and the
  facilitator as a capability attached to a normal agent (`omadia-agent-facilitator` ≤ 0.7.x)

## Context and Problem Statement

Teams need an impartial moderator for group processes (decisions, prioritisation,
assignment, retrospectives, meetings). The first facilitator was a capability attached to
a normal agent and a Conductor pattern; it lost state on restarts, ran an hourly model
tick, and inherited its host agent's business access and memory, which makes a moderator
partial. #2092 then built native facilitators as `agents.kind` with the engine in a plugin
bound through an `extension` capability and a SQL grant.

Where does the facilitator live, what may it do, and what does the kernel guarantee?

## Decision Drivers

- A moderator must be neutral by construction, not by prompt.
- As much logic as possible in the plugin; the kernel keeps what a plugin cannot safely own.
- Every action, model or not, bounded by deadline, budget and kill switch.
- Works in Teams first, through plain text in every channel.

## Considered Options

- **A — Facilitator archetype; engine in an archetype plugin; kernel-guarded services**
- **B — Engine in the kernel** (the first draft of the spec)
- **C — Facilitator as a working mode or capability of a standard agent** (the old model)

## Decision Outcome

Chosen option: **A**, following [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md).

| Part | Owner |
|---|---|
| Archetype registry, `agents.archetype`, enforced omissions, neutrality block, persona bounds | Kernel |
| Stored inbound message events (`conversationMessages`), process-bound reads | Kernel |
| Delivery of every group message for an active facilitation | Kernel subscription and channel plugins |
| Posting and DMs as the facilitator's own identity; `no_identity` instead of another bot; allowed targets per scope | Kernel |
| Every model turn (`agentTurn`) and execution authorization for every action | Kernel |
| Readiness and session-capability registries | Kernel (pass-through) |
| Tables, lifecycle, contributions, decision methods, scheduler and outbox, transparency, process, visibility, retention, quotas, sessions, media-adaptive playbook | Plugin (`omadia-agent-facilitator`, manifest kind `archetype`) |
| Facilitation-scoped capabilities (free/busy, invitations, protocol mail) | Plugin with `omadia-m365-connector`, under kernel-issued scoped grants |

- **Deliberately omitted** (kernel-enforced at write time and in wiring): business
  capabilities, acting for a user, general memory across facilitations, assistance outside
  a facilitation, consulting or being consulted, default-agent role, identity switching,
  fast lane, private channels to the initiator the group does not know about.
- **Neutrality contract** compiled into every facilitator prompt, not removable by
  identity, instructions or persona settings: no opinion on content, never votes or
  weights, names who is missing only neutrally, discloses report targets, stops on the
  group's "stop". Persona axes stay within kernel-validated bounds; operator instructions
  are checked against the contract at save time.
- **Five execution scopes** (`configuring`, `active`, `closing`, `scheduling`,
  `follow_up`), each with its own deadline, budget and allowed targets; an expired scope
  never re-opens moderation.
- **Decision methods** count deterministically; the model never counts votes.
- **Owner decisions OD-F1 to OD-F4:** a facilitator needs its own channel identity; the
  group (not the initiator) changes the definition of done or method by consent; private
  reminders by DM are allowed where the channel allows; retention is an instance setting,
  default 90 days.
- **Rollout:** expand/contract steps K1 to K6 (K1 = #2104, merged); `agents.kind`,
  `facilitationEngine@1` and the SQL grant as trust are removed only in K6, after the
  archetype plugin versions run live.

### Consequences

- 🟢 **Good:** Neutrality is enforced by the kernel, so groups can trust the moderator.
- 🟢 **Good:** The engine evolves in its own repo and release cycle.
- 🔴 **Bad:** Large contract surface between kernel and plugin (`conversationMessages`,
  `agentTurn`, execution authorization, scoped grants), versioned in `@omadia/plugin-api`.
- 🔴 **Bad:** No Teams test tenant: contract tests against a simulated transport plus a
  manual checklist on a real instance.
- ⚪ **Neutral:** Epic #2043, issues #2060 to #2068, #2070, #2076 to #2078, #2088 to #2091;
  `omadia-agent-facilitator#17`, `omadia-channel-teams#43/#44`, `omadia-m365-connector#18`.

## Pros and Cons of the Options

### A — Archetype plugin

- 🟢 Thin, stable kernel guarantees; plugin owns the domain logic.
- 🔴 Needs schema-limited DB roles and the fetch sandbox before it is fully safe.

### B — Engine in the kernel

- 🟢 Fewest trust boundaries.
- 🔴 Every facilitation change is a kernel release; the kernel grows a domain engine.

### C — Mode or capability of a standard agent

- 🟢 No new concept.
- 🔴 Inherits the host agent's access and memory; neutrality cannot be guaranteed.

## More Information

- Spec B: `specs/2043-native-facilitators/spec.md` (§0 is authoritative over the rest of B;
  §0.1 lists what #2092 built and which issue closes each gap; §9 acceptance criteria).
- Related: [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md),
  [ADR-0020](0020-proactive-agents-with-bounded-triggers.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md).
