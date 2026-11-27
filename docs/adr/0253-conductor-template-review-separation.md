# 0253 — Conductor template review requires a second available operator

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers, Wave 5 Conductor (#1719)
- **Refines:** [ADR-0132](0132-conductor-workflow-templates-are-slot-parameterized-data.md)

## Context and Problem Statement

Every operator can review a pending workflow template, including its author. Single-operator installations still need a way to share templates.

## Decision Drivers

- Apply separation of duties when a second active operator account exists.
- Keep the single operator tier and record each review transition.

## Considered Options

- **A — Require another active operator when one exists**
- **B — Permit author approval everywhere and mark it in the audit trail**

## Decision Outcome

Chosen option **A**. Author approval returns 403 when another active operator exists. A single operator may self-approve, and the audit row records that fact. Submit, approve and reject compare the observed status and version atomically and write audit rows under [ADR-0100](0100-admin-audit-trail-one-actor-rule.md). Publishing a new template version returns it to private so it receives its own review.

The gallery supplies the version shown on its card when approving or rejecting. A stale version returns 409. An API client that omits the optional reviewed version reviews the pending version observed by the server during that request.

### Consequences

- A second person reviews new versions where multiple operators are active.
- An active account that is temporarily unavailable can delay sharing.

## More Information

`templateRoutes.ts`, `templateStore.ts`, `userStore.ts`. The approval policy can be changed without migrating templates.
