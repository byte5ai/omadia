# 0021 — Deterministic first, side channels for data, natural chat answers

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** —

## Context and Problem Statement

Many harnesses route nearly everything through a model. In omadia, data answers still
often pass rows through the model, the fast path runs planner and router models before
the agent, and answers carry a growing set of chips, footers and buttons (AI chip,
verifier badge, system-data chip, "Direkte Antwort von", "Konsultiert", length buttons,
follow-up buttons, Direct-Line buttons; 👀 reactions in Slack, Discord, WhatsApp). Many
channels cannot render those elements at all, and the colleague feeling breaks.

Where should a model run at all, how does data reach people, and what does an answer look
like?

## Decision Drivers

- Deterministic is faster, cheaper, more reliable and uncritical for data protection
  (INV-11).
- Data from source systems should not need a model to pass through or be checked.
- The chat of the customer's existing channel is the primary UI for now.
- Every capability must work in plain text in every channel; nothing Teams-only.

## Considered Options

- **A — Deterministic first, side-channel data, decoration registry, channel parity**
- **B — Model-centric answers with richer cards per channel**
- **C — Status quo, tune per channel**

## Decision Outcome

Chosen option: **A**.

- **Decision rule for every component:** before a step uses a model, its design states why a
  deterministic path is not enough. Deterministic by default: routing, permissions,
  discretion, counting, scheduling, pre-checks, templates, data retrieval, formatting,
  rendering, protocol assembly, delivery. Model only for free-text understanding,
  judgement, open reasoning, situational language.
- **Side channel for data:** the agent decides which data action runs; a boundary check runs
  on the action description first; the harness executes it under the agent's grants, applies
  discretion and the audience floor, and renders the result (emission type `data`) under the
  agent's identity with AI disclosure. The model receives a status (success, row count,
  columns, refusal), not the rows; it gets exactly the fields it needs, masked, only when it
  must reason over them. Data actions and fast-lane recipes are agent capabilities; the fast
  path's planner and router models before the agent go.
- **Natural, uncluttered answers:** the message body holds what a good colleague would say;
  everything else lives in structured fields and on-demand details. Answers are short by
  default. Name lines appear only where the speaker would otherwise be unclear.
- **Every decoration is justified:** chips, footers, status lines and buttons are declared in
  one registry with a written justification (legal requirement, or a concrete likely next
  action that saves typing) and the channels that render them; the channel SDK refuses
  undeclared decorations and a test fails on new ones.
- **Channel parity:** every agent capability, including choosing an agent, giving consent or
  voting, works through plain text in every supported channel; rich elements are optional
  enhancements.
- **AI disclosure** stays as the EU AI Act requires, in the most discreet form the channel
  offers; the structured field is on every answer; how often channel markers appear is an
  operator setting (#2087), default today's behaviour until OD-5 is settled.

### Consequences

- 🟢 **Good:** Lower latency and cost, fewer hallucinated figures, less data exposed to models.
- 🟢 **Good:** Answers read like a colleague's message in every channel.
- 🔴 **Bad:** Every channel plugin must render `data` emissions and drop undeclared
  decorations; Teams cards lose several familiar elements.
- ⚪ **Neutral:** Issues #2085, #2086, #2087, #1876; channel-repo issues for speaker and
  contribution rendering; acceptance criteria 25, 29 to 31, 35.

## Pros and Cons of the Options

### A — Deterministic first

- 🟢 Cheap, reliable, private by default; consistent across channels.
- 🔴 Requires discipline in every new component's design.

### B — Model-centric, richer cards

- 🟢 Flexible presentation.
- 🔴 More cost and data exposure; Teams-only features creep in.

### C — Status quo

- 🟢 No work.
- 🔴 Clutter keeps growing; data keeps flowing through models.

## More Information

- Spec INV-11; §5.13, §5.14. Precedents: privacy-shield canvas-sentinel side channel
  (`docs/security-architecture.md`), routine output templates.
- Related: [ADR-0013](0013-speaker-stamping-and-identity-guard.md) (emission types),
  [ADR-0006](0006-in-context-background-stream-surfacing.md) (no toasts).
