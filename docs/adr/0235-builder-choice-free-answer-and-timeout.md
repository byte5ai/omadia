# 0235 — Builder choices accept free answers and expire after five minutes

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** W21 cluster lead
- **Related:** [ADR-0056](0056-builder-agent-bounded-by-deterministic-gates.md), [ADR-0069](0069-upstream-issue-reporting-as-the-operator-or-a-scoped-app-never-unreviewed.md)

## Context and Problem Statement

A choice card blocks a Builder turn while the operator replies. The previous 30-minute choice deadline exceeded the 15-minute turn budget, and the card constrained the reply to its prescribed options.

## Decision Outcome

Open questions belong in chat. A choice card offers named options, a free answer, and dismissal. The draft owner can send an option as `{ value }`, free text as `{ answer }` (1–2,000 characters after trimming), or `{ cancel: true }` to the same route. The tool receives free text as `answer`, distinct from the `value` selected by a button. Actions requiring confirmation keep their separate confirmation step.

A pending choice expires after five minutes. Timeout, dismissal, and Stop wake the tool and close the card in other tabs over the existing event stream. The draft owner can continue the conversation after the turn completes.

## Considered Options

- Keep the fixed menu and require the operator to stop the turn to type a different answer.
- Accept a separate free-text answer and govern its wait independently of the turn. Chosen to preserve explicit option selection and give the operator a way to clarify.

## More Information

Issue #1803. The five-minute deadline can be adjusted independently of the wire contract.
