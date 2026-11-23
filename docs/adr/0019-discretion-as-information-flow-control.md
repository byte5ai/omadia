# 0019 — Discretion as information flow control

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** —

## Context and Problem Statement

The memory system already applies context rules to recall (context-memory ACL, migrations
0050 and 0062), but it is off by default (`agents.context_memory = off`) and covers only
memory. Capability results, outbound interface calls and agent-to-agent communication have
no such rule. An agent that learned something in an HR 1:1 can repeat it in a team channel,
pass it to a colleague agent, or write it into a CRM.

How does an agent always know whom it may tell what, and how much?

## Decision Drivers

- Discretion is a core virtue of an ideal colleague (INV-9).
- Model output cannot be traced token by token; the rule must hold anyway.
- Deterministic checks, no model in the decision.
- A blocked flow must not leak the fact that something was withheld where that matters.

## Considered Options

- **A — Labels at entry, turn label set, flow rule at every egress, disclosure levels**
- **B — Output filtering** (redact sensitive content after generation)
- **C — Memory ACL only** (today's scope, switched on by default)

## Decision Outcome

Chosen option: **A**.

- **Labels** at every entry point: memory entries (context tier and key plus the labels of
  their sources), capability results (source system, grant, principals, privacy field
  classification from migrations 0065/0066), messages (conversation and members),
  contributions of other agents (their labels), instructions and skills (operator
  classification).
- **Turn label set:** union of everything read in the turn; every output carries the whole
  set (strictest wins). Labels persist transitively into memory, history, summaries and
  protocols.
- **Mask at entry, not at exit:** a label is lowered only by a named deterministic
  transformation (privacy shield masking, deterministic aggregate). If an egress fails the
  rule anyway, the output is refused whole or regenerated from permitted context, never
  redacted afterwards.
- **Flow rule at every egress:** answers and posts (audience floor), contributions to other
  agents (receiver's grants and its readers), memory writes (context-memory ACL write
  rules), outbound capability calls carrying data (the integration's declared
  readership; undeclared integrations get no restricted or classified data).
- **Disclosure levels** per grant and classification: `full`, `redacted`, `aggregate`
  (deterministic only), `existence`, `none`. At `none` the answer is indistinguishable
  from "no such information".
- **Defaults:** context-memory ACL on for every agent in mode `members`; never `off` for an
  agent with access to classified data; consultation grants default `none`. Every blocked
  and allowed cross-context flow is audited with labels, never with content.

### Consequences

- 🟢 **Good:** Sharing between agents and systems becomes safe enough to enable at all.
- 🟢 **Good:** One mechanism covers memory, capabilities, consultations, triggers and
  outbound calls.
- 🔴 **Bad:** Conservative by design: transitive labels make long conversations
  progressively stricter.
- 🔴 **Bad:** Operators must declare integration readership to send restricted data out.
- ⚪ **Neutral:** Issue #2079; acceptance criteria 16 to 19, 24, 27, 38.

## Pros and Cons of the Options

### A — Labels and flow rule

- 🟢 Deterministic and complete across egress paths.
- 🔴 Broad kernel change; needs careful defaults to stay usable.

### B — Output filtering

- 🟢 Easy to bolt on.
- 🔴 Paraphrases escape filters; redacting afterwards still reveals that something existed.

### C — Memory ACL only

- 🟢 Already built.
- 🔴 Leaves capabilities, agent-to-agent and outbound calls uncovered.

## More Information

- Spec INV-9; §5.11; `docs/teams-multi-agent-identities.md` §8.
- Related: [ADR-0018](0018-consultation-instead-of-delegation.md),
  [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md).
