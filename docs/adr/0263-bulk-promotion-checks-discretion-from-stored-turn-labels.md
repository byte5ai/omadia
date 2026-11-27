# 0263 — Bulk promotion checks discretion from the stored turn labels; operators may un-retire a turn

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** W31 cluster lead (wave 6 autonomy grant)
- **Supersedes:** — (closes a residual of [ADR-0190](0190-memorable-knowledge-promotion-and-merge-lifecycle.md))

## Context and Problem Statement

Live auto-promotion asks `guardMemoryEgress` (spec 2042 §5.11 "Memory write") whether what the
turn read may go into the tier the new entry lands in. Bulk promotion (ADR-0190) promotes stored
turns long after they ran, outside any turn, so the live check had nothing to read and the bulk
path skipped it (#2294): a turn that read another conversation could be promoted into a tier
whose readers may not know it. How does an offline pass apply the same rule?

## Decision Drivers

- Same outcome for the same turn, live or bulk.
- The check belongs to the kernel (discretion store, flow rule); the bulk service is published
  by a plugin (`harness-orchestrator-extras`).
- Fail closed.

## Considered Options

- **A — Kernel gate per stored turn, injected by decorating the published service.**
- **B — Move the flow rule into the extras plugin.**
- **C — Refuse bulk promotion of every turn that carries labels.**

## Decision Outcome

Chosen option: **A**.

- **Contract.** `BulkPromoteRunOptions.mayPromote?(candidate)` (plugin-api 1.109.0) with
  `BulkPromoteCandidate { turnId, owners?, agentSlug? }`. The provider asks it for every promote
  candidate before any LLM call; `false` or a throw counts the turn as `skipped` and retires it
  (`promotionRetired.reason = discretion`). Unretired, the same high-significance turns would
  head every later run and use up its promote limit.
- **Kernel.** `serviceRegistry.decorateOnProvide('bulkPromotion', withBulkPromotionGate)`
  (`discretion/bulkPromotionGate.ts`) puts the gate on every run, whoever provides the service.
  The gate reads the label set the turn record persisted (`labelsOf('turn', …)`) and runs
  `checkFlow` with egress `memory`: readers are the owners of a member-scoped turn, otherwise
  unknown (the agent's own memory). A refusal is audited (`target: bulk-promotion`).
- **Own conversation.** A stored set does not mark which context label is the turn's own. With
  exactly one context label it is read as the own one and passes into its own tier, as live;
  with two or more, the readers must cover every context.
- **Unlabelled turns** (written outside a labelled turn) pass, as they do live.
- **Un-retire (#2295).** ADR-0190 retires a turn for good. An operator may now lift a retirement
  with reason `memory_deleted` or `discretion` (`GET /api/v1/admin/bulk-promote/retired`,
  `POST …/unretire`, admin audit `memory.promotion_unretire` written first). `no_person_owner`
  stays retired (409; ADR-0190, #1864); `hygiene` is not offered (the next run retires it again).
  Lifting `memory_deleted` lets bulk promotion rebuild knowledge its owner deleted: a deliberate,
  audited operator act. A lifted `discretion` turn passes the gate again on the next run, so it
  is promoted only when its readers now allow it.

### Consequences

- 🟢 **Good:** Bulk and live promotion refuse the same cross-conversation turns.
- 🟢 **Good:** The plugin keeps no copy of the flow rule.
- 🔴 **Bad (accepted risk):** A turn whose own conversation label was never stored (no context
  key at write time) but that read exactly one foreign conversation is treated as its own
  conversation and passes into agent memory.
- 🔴 **Bad:** A failed label lookup retires the affected turns (fail closed); the operator lifts
  them from the retired list.
- 🔴 **Bad:** Any operator session can lift a `memory_deleted` retirement; only the audit row
  records who did it.
- 🔴 **Bad (accepted risk):** a plugin granted `bulkPromotion@1` can `replace()` the service with
  an undecorated wrapper; `replace` applies no decorators (same as for `processMemory`).

## Pros and Cons of the Options

### A — Kernel gate via decoration

- 🟢 One rule, enforced for any provider.
- 🔴 One more optional run option in plugin-api.

### B — Flow rule in the plugin

- 🔴 Two copies of a security rule that drift.

### C — Refuse every labelled turn

- 🟢 Simple and safe.
- 🔴 Since S5 nearly every turn carries its own conversation label; bulk promotion would stop.

## More Information

Issues #2294, #2295; ADR-0190, ADR-0181, ADR-0183; spec 2042 §5.11.
