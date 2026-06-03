# 0005 — Two-phase confirmation for write-capable connectors

## Status

Accepted

- **Date:** 2026-06-03
- **Deciders:** Core maintainers
- **Supersedes:** —

## Context and Problem Statement

Integrations started out read-only, but agents increasingly need to *act* in
external systems — create a page, update a record, post a comment. A language
model deciding to mutate a system of record carries real risk: a hallucinated or
misjudged write can damage data a human did not intend to change.

How should the platform expose write capability so that agents can be useful
*and* an erroneous write cannot silently take effect?

## Decision Drivers

- **Human-in-the-loop for mutations:** a person should be able to see and approve
  what an agent is about to change before it is applied.
- **Reversible / low-blast-radius by default:** the default path must not commit
  an irreversible change to a live system on the model's say-so.
- **Explicit, typed intent:** the system must distinguish a *read* from a *write*
  in the connector contract, not infer it.
- **Consistent across connectors:** the same safety model should apply to any
  write-capable integration, not be reinvented per connector.
- **Honest UX:** the agent must tell the user that what it produced is a proposal,
  not a fait accompli.

## Considered Options

- **A — Two-phase confirm + draft-by-default**
  Writes are typed explicitly in the connector contract. A write is a two-step
  flow: the agent first presents a preview of the exact change; only after
  confirmation is it sent. Where the target system supports it, the write lands
  as an unpublished **draft** requiring human review rather than going live.
- **B — Direct writes with post-hoc audit log**
  Apply writes immediately; record them so a human can review/undo afterwards.
- **C — No writes (stay read-only)**
  Disallow mutation entirely; humans perform all changes.

## Decision Outcome

Chosen option: **A — Two-phase confirm + draft-by-default**, because it lets
agents do useful work while guaranteeing a human checkpoint before anything
changes a system of record, and degrades safely: even after confirmation, writes
prefer a reviewable draft state over a live publish wherever the target system
offers one. Intent is explicit in the contract, so the platform can enforce the
safety model uniformly across connectors.

### Consequences

- 🟢 **Good:** No agent-initiated write reaches a live system without a human
  seeing the exact change first.
- 🟢 **Good:** Where supported, the result is a draft a human still has to
  publish — a second, system-native safety net beyond the confirm step.
- 🟢 **Good:** Read vs. write is a typed distinction in the connector contract,
  so capability and auditing are explicit rather than inferred.
- 🔴 **Bad:** Every write is at least two interactions — slower than a direct
  apply, and unsuitable for high-volume autonomous mutation.
- 🔴 **Bad:** "Draft-by-default" depends on the target system supporting an
  unpublished state; connectors to systems without one must fall back to the
  confirm step alone.
- ⚪ **Neutral:** Agent instructions and preview copy must clearly state the
  draft/proposal nature so users are not misled into thinking a change is live.

## Pros and Cons of the Options

### A — Two-phase confirm + draft-by-default

- 🟢 Human checkpoint before any change; native draft as a second net; explicit
  typed intent; uniform across connectors.
- 🔴 Extra round-trip per write; draft state not available in every target system.

### B — Direct writes + audit log

- 🟢 Fast; fully autonomous; complete history for review.
- 🔴 Damage is already done by the time a human looks; undo is best-effort and
  impossible for some operations — wrong default for systems of record.

### C — Read-only

- 🟢 Zero write risk.
- 🔴 Severely limits agent usefulness; pushes all action back onto humans.

## More Information

The first write-capable connector to adopt this model demonstrated the pattern:
writes are presented as a preview, confirmed, and then created as drafts for
human review. The read/write intent distinction is part of the connector entity
contract.
