# 0315 — Under a shield, the own conversation's plans follow the plan rule, not the session tail

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** W42 cluster lead (decision after the recommendation in #2333, reversible)
- **Supersedes:** — (refines [ADR-0097](0097-unprotected-provenance-for-stored-content.md) and
  [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md))

## Context and Problem Statement

ADR-0097 keeps content written outside a Privacy Shield out of shielded turns. It accepts one
residual: the same chat's session tail and briefing keep that chat's unprotected turns, for
conversation continuity. A plan is derived content. The recall plan leg drops a plan whose
turn is unprotected or unknown (#1536). A plugin's bounded `listPlansForScope`,
`getPlan` and `getPlanSteps` read only the turn's own conversation, but did not filter
under a shield (#2333). Nothing said whether own-conversation plans follow the tail (keep them)
or the plan leg (drop them).

## Decision Drivers

- A plan holds the strategy and step text, which the detectors mostly miss.
- The continuity residual is an exception accepted for what the user wrote, not a rule for
  derived content.
- The plan runner must keep reading and updating the plan of the turn it runs in. That plan's
  Turn node exists only after the turn ends.
- One rule per node type across recall, `getNeighbors` and the bounded plan reads.

## Considered Options

- **A — Plan rule:** under a shield, a plugin reads only plans linked to a known turn that is
  not `unprotected`, plus the current turn's own plan.
- **B — Continuity exception:** own-conversation plans follow the session tail and stay
  readable; record that in ADR-0097 and in the memory-ACL oracle.

## Decision Outcome

Chosen option: **A**, because it matches what the recall plan leg and the shielded
`getNeighbors` already do (`hasProtectedTurn`), and it keeps the continuity residual narrow.

- `listPlansForScope` under a privacy handle filters to readable plans. `getPlan`,
  `getPlanSteps`, `getPlanStepsForPlans` and `deletePlan` treat an unreadable plan as missing.
  `setPlanStepStatus` refuses it as `out-of-scope`.
- Readable means: not stamped `unprotected`, and either the current turn's own plan
  (`props.planId === turnContext.turnId`) or linked to at least one Turn, none of them
  `unprotected` (`isPlanReadableUnderShield`, `src/platform/shieldedNeighbors.ts`).
- Without a shield nothing changes.

### Consequences

- 🟢 **Good:** A plugin reads no plan text written outside the shield, the same as the model's
  recall.
- 🟢 **Good:** The plan runner keeps its current plan. Its verifier mark and GC still work on
  it.
- 🔴 **Bad:** In a chat that ran unshielded earlier, the plan runner's GC no longer sees the
  older plans after a shield is installed and leaves them in place. The quota and decay rules
  still cover them.
- ⚪ **Neutral:** The memory-ACL oracle keeps its plan rule. The known-leak `todo` tests for
  #2333 become regular tests.

## Pros and Cons of the Options

### A — Plan rule

- 🟢 One rule for plans everywhere. No new exception to document.
- 🔴 Needs the current-turn exemption, because a fresh plan has no linked turn yet.

### B — Continuity exception

- 🟢 No code change.
- 🔴 Widens an accepted residual to derived text the user never typed into the chat.

## More Information

- Issues #2333, #1536, #1540. Test: `test/boundedGraphServices.test.ts` ("#2333 · bounded plans
  under a Privacy Shield").
- The same pass (#2334) makes `processMemory` `get` / `history` / `edit` treat an `unprotected`
  process as missing under a shield. That applies ADR-0097's process rule to the bounded
  service and needs no separate record.
