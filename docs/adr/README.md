# Architecture Decision Records

This directory records the significant architecture decisions behind **Omadia**,
an agentic operating system for building and running teams of AI agents across
channels, integrations, and a shared knowledge graph.

We use the [MADR](https://adr.github.io/madr/) format. Each record captures a
single decision: the problem, the options we weighed, what we chose, and the
consequences we accepted. ADRs are immutable once **Accepted** — to change a
decision, write a new ADR and mark the old one **Superseded by …**.

## Why we keep ADRs

- Make the *reasoning* behind the architecture durable, not just the code.
- Give new contributors the "why", not only the "what".
- Avoid re-litigating settled trade-offs.

## Writing a new ADR

1. Copy [`0000-template.md`](0000-template.md) to the next free number:
   `NNNN-short-kebab-title.md`.
2. Fill in Context, Decision Drivers, Considered Options, Decision Outcome,
   and Consequences.
3. Open it as **Proposed**; flip to **Accepted** once agreed.
4. Add a row to the index below.

## Index

| #    | Title                                                              | Status   | Date       |
| ---- | ------------------------------------------------------------------ | -------- | ---------- |
| 0001 | [Plugin distribution via signed ZIP packages](0001-plugin-distribution-via-signed-zip.md) | Accepted | 2026-06-03 |
| 0002 | [MIT license for the open-source core](0002-mit-license-for-oss-core.md) | Accepted | 2026-06-03 |
| 0003 | [Capability-based, multi-provider middleware](0003-capability-based-multi-provider-middleware.md) | Accepted | 2026-06-03 |
| 0004 | [Knowledge graph as the agent memory substrate](0004-knowledge-graph-as-memory-substrate.md) | Accepted | 2026-06-03 |
| 0005 | [Two-phase confirmation for write-capable connectors](0005-two-phase-confirmation-for-writes.md) | Accepted | 2026-06-03 |
| 0006 | [In-context surfacing for background chat streams (no toasts)](0006-in-context-background-stream-surfacing.md) | Accepted | 2026-07-02 |

> These first records are written *retroactively* — they document decisions that
> were already implemented and proven in the product. New decisions should be
> recorded *before* or *while* they are implemented.
