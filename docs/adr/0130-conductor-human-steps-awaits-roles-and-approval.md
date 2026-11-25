# 0130 — Conductor human steps: durable awaits, late-bound roles, an explicit path for a rejection

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; spec 005 (US5, US6, clarifications of 2026-06-16) in
  #388; holder-authorized resolution #394; role sources #726 (#333 phases 2 and 3, #754);
  strict approval #759 (#765); timer steps #830 (#330 C3); rejection rule #1698 (recorded
  retroactively from the code on main)

## Context and Problem Statement

A human step asks a person, or whoever holds a role, to decide. The answer may come days
later, the person may have moved on, a directory may be unreachable, and the answer arrives
through a chat card whose payload a client controls. The decision often gates something
irreversible. Who may answer, who counts, and what does a missing or negative answer mean?
This record is retroactive.

## Decision Drivers

- A pending decision survives restarts (the earlier `ask_user_choice` was in memory).
- A role is a baton: it must reach whoever holds it now, not whoever held it at start.
- An incomplete picture of the holders must never complete an approval.
- A refusal must not run the action it was asked about.
- A step that nobody can answer must not hang the run.

## Considered Options

- **A — Durable awaits; roles resolved live through a holder registry that reports partial
  results; quorum `any | all`; rejection needs a guarded edge; strict approval opt-in**
- **B — Freeze the responders at dispatch** (store user ids on the await)
- **C — Approval strict by default** (only `{approved: true}` approves, everywhere)
- **D — Deadline handling by a separate escalation workflow**

## Decision Outcome

Chosen option: **A**.

- **An await is a row** (`conductor_awaits`): opened when the run parks, closed by one
  conditional `UPDATE … WHERE status = 'waiting'`. A response and the deadline race on that
  statement; the loser does nothing.
- **Principals** are `user:<id>` or `role:<key>`. Ids are compared in canonical form (trim,
  lowercase; `principalId.ts`). **Roles are late-bound:** holders are resolved at dispatch,
  at every reminder and at every response through the `RoleHolderRegistry`. The local
  assignment table is one ordinary source with the reserved id `conductor-local`; external
  sources register beside it.
- **A partial lookup is never a conclusion.** The executor receives an
  `AggregateHolderLookup`, not a list. With a source unavailable, `quorum: 'all'` refuses to
  complete, and an empty holder list is not read as "nobody holds this role". The run then
  waits for its deadline. The inbox and the reminder worker may use the shrunken list.
- **Only a current holder may answer.** `resolveAwait` refuses any other responder
  (`AwaitResponderNotHolderError`), whatever the card payload says.
- **Quorum** is `any` (default: first holder decides) or `all` (every current holder; the
  aggregate counts only current holders). `all` requires a deadline and a fallback.
- **No holder, no hang:** a step with no reachable holder takes its in-graph fallback or
  fails, and records `no_role_holder` even when the fallback saves the run.
- **The deadline fallback is an in-graph transition.** A deadline-bearing step must declare
  one. A timeout is recorded as `await_timed_out` on the step.
- **Approval is fail-open by default, strict by opt-in.** Without `human.strictApproval`
  only an explicit `{approved: false}` rejects. With it, only an explicit
  `{approved: true}` approves. `validate()` warns (`approval_fail_open`) when a fail-open
  step directly gates an action.
- **A rejection leaves only on an edge that asks for it (#1698).** A human step whose
  result says `approved: false` never takes an unguarded transition, not the deadline
  fallback and not a terminal completion; without a matching guard the run ends `failed`
  with `approval_rejected_no_transition`. `validate()` warns with
  `rejection_unguarded_edge` and `timeout_equals_approval`.
- **A timer step is an await without a holder** (`principal_kind = 'timer'`): it parks for
  an ISO-8601 duration and then fires its fallback. It is not listed in the operator inbox.
- **The message is rendered once,** when the await opens (dash for an unresolved token).

### Consequences

- 🟢 **Good:** Approvals survive deploys and follow the baton; a card recipient who is not
  a holder cannot decide.
- 🟢 **Good:** A refused approval can no longer run the gated action through an unguarded
  edge.
- 🔴 **Bad:** The default stays fail-open: an absent or malformed response approves unless
  the author sets `strictApproval`. The warning is non-blocking.
- 🔴 **Bad:** An unreachable holder source stalls a `quorum: 'all'` step until its deadline.
- 🔴 **Bad:** Existing graphs with an unguarded edge after a human step now fail on a
  rejection instead of advancing.
- ⚪ **Neutral:** A parked timer is visible only in the workflow's run history, without its
  deadline; a read-only inbox row was considered in #1712 and not built.

## Pros and Cons of the Options

### A — Durable awaits, live holders, guarded rejection

- 🟢 Fails closed where it matters (quorum, holder gate, rejection).
- 🔴 More concepts for a workflow author.

### B — Frozen responders

- 🟢 Simple and stable.
- 🔴 A person who left the role still decides; the new holder cannot.

### C — Strict by default

- 🟢 Safest.
- 🔴 Changes the meaning of every published human step that relies on the raw response.

### D — Escalation workflow

- 🟢 Reusable escalation.
- 🔴 Rejected in the spec clarification to keep the engine lean.

## More Information

- Code: `middleware/src/conductor/{awaitStore,awaitWorker,roleStore,roleHolderResolver,principalId,runExecutor}.ts`,
  `middleware/packages/conductor-core/src/{engine,validate}.ts`; migrations `0001`, `0002`,
  `0003`, `0011_timer_awaits.sql`.
- Tests: `middleware/test/conductorAwaitStore.test.ts`, `conductorQuorumAndTimeout.test.ts`,
  `conductorReminders.test.ts`, `conductorCancelAndStrictApproval.test.ts`,
  `conductorTimerStep.test.ts`, `conductorPrincipalRef.test.ts`.
- Related: [ADR-0005](0005-two-phase-confirmation-for-writes.md),
  [ADR-0038](0038-conductor-routes-check-id-shape-400-then-404.md),
  [ADR-0131](0131-conductor-pure-engine-decides-the-kernel-performs.md),
  [ADR-0128](0128-conductor-durable-runs-lease-fencing-and-reconcile.md).
