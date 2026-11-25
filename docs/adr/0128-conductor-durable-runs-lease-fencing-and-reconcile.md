# 0128 — Conductor runs: a checkpoint per step, a fenced lease, reconcile as the resume path

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; spec 005 (US2, plan §7-E), implemented in #388; cancel
  in #759 (#765), reserved context keys in #1702, failure causes in #1699 (recorded
  retroactively from the code on main)

## Context and Problem Statement

A workflow run waits hours or days on a person, a timer or an event, and an agent step is a
real model turn that can take minutes. The kernel restarts on every deploy and may run as
several replicas. A run must survive that without being lost, without being driven by two
owners, and without a caller steering it from outside. How is a run made durable, and who
may write to it? This record is retroactive.

## Decision Drivers

- No run may stay `running` forever with no owner and no recorded cause.
- No step that was recorded may run again; two drivers must never advance the same run.
- The instance may sit behind a transaction-mode pooler
  ([ADR-0034](0034-no-session-state-behind-a-transaction-pooler.md)).
- A trigger payload is untrusted input; executor state is ground truth.
- An operator must be able to stop a run.

## Considered Options

- **A — Step-record checkpoint, lease fencing on every write, a polling reconcile worker,
  cancel at the step boundary**
- **B — Resume through `LISTEN/NOTIFY`** as the primary path
- **C — Idempotency keys per effect** for exactly-once steps
- **D — In-memory runs** re-created from triggers after a restart

## Decision Outcome

Chosen option: **A**.

- **Checkpoint.** `recordStepAndAdvance` writes the completed step row and the run's new
  `current_step_id` and context in one transaction, before the next step begins (FR-004).
  Resuming from `current_step_id` therefore never repeats a recorded step.
- **Lease.** Every driver holds a random token in `conductor_runs.claimed_by`; each step and
  park write is `WHERE claimed_by = <token>`. Zero rows means `RunLeaseLostError`: the
  superseded driver stops. Each recorded step refreshes `claimed_at` as a heartbeat.
- **Reconcile is the source of truth.** `ConductorRunResumeWorker` polls every 60 s and
  claims `running` rows whose heartbeat is older than `DEFAULT_RESUME_STALE_MS` (15 min)
  with `FOR UPDATE SKIP LOCKED`, at most 20 at a time. The `pg_notify` triggers of migration
  0001 are an optimisation nothing depends on. Dry runs are never resumed.
- **A binding ordering:** `DEFAULT_STEP_TIMEOUT_MS` (10 min, `realStepEffects.ts`) must stay
  strictly below the stale window, so a live step settles before its run can be claimed. A
  test asserts the ordering.
- **Accepted residual: at-least-once for one step.** A step whose effect ran but whose
  record never committed is executed again after a crash. There are no effect idempotency
  keys. The step timeout does not kill the underlying turn; the run only stops waiting.
- **Versions are immutable.** A publish appends a version and moves `active_version_id`;
  a run stays on the version it started with.
- **Cancel is honoured at the step boundary.** `cancel_requested_at` is set atomically on a
  non-terminal run and never cleared; a waiting run is finalized at once, a running one at
  its next boundary, and every park re-checks the flag. No mid-step kill.
- **Executor-owned context keys.** `steps`, `stepAttempts`, `transcript` and
  `transcriptText` are stripped from every start payload at the one gate, `startRun`
  (and `previewRun`), by `sanitizeRunContext`. Only top-level keys are reserved;
  `ctx.speaker` is deliberately caller-owned.
- **Every end has a cause.** A failed step records a redacted, truncated `ConductorRunError`;
  the run row copies it (`error_code`, `error_message`, migration 0013).
- **Run-ended notification is at-least-once** and fire-and-forget; outbound webhook
  subscribers must tolerate a duplicate in the expire-versus-cancel race.

### Consequences

- 🟢 **Good:** A restart loses no run; a stalled driver cannot corrupt a run another owner
  took over.
- 🟢 **Good:** Works behind a transaction pooler; no session state, no listener required.
- 🔴 **Bad:** An orphaned run waits up to 15 minutes plus one poll interval before it moves.
- 🔴 **Bad:** One step can run twice after a crash; a non-idempotent action step (a POST,
  a connector write) can therefore happen twice.
- 🔴 **Bad:** A running step cannot be cancelled; the operator waits up to the step timeout.
- ⚪ **Neutral:** Workers are in-process timers, started only when Postgres is available;
  cross-replica exclusivity comes from the row claim, not from a leader.

## Pros and Cons of the Options

### A — Checkpoint, lease, reconcile

- 🟢 Simple invariants that hold across replicas and poolers.
- 🔴 Slow orphan recovery; at-least-once for one step.

### B — `LISTEN/NOTIFY` as primary

- 🟢 Immediate resume.
- 🔴 Needs a direct connection; a lost notification loses the run.

### C — Effect idempotency keys

- 🟢 Closes the duplicate-step window.
- 🔴 Every connector and agent turn would need to honour a key; none does today.

### D — In-memory runs

- 🟢 No schema.
- 🔴 A human approval that takes a day cannot survive a deploy.

## More Information

- Code: `middleware/src/conductor/{runExecutor,runStore,runResumeWorker,runContext,runError,workflowStore}.ts`,
  migrations `0001_conductor.sql`, `0004_conductor_run_claim.sql`, `0008_run_cancel.sql`,
  `0013_conductor_run_error.sql`.
- Tests: `middleware/test/conductorResumeWorker.test.ts`, `conductorQuorumAndTimeout.test.ts`
  (timeout below stale window), `conductorCancelAndStrictApproval.test.ts`,
  `conductorReservedContextKeys.test.ts`, `conductorRunError.pg.test.ts`.
- Related: [ADR-0034](0034-no-session-state-behind-a-transaction-pooler.md),
  [ADR-0041](0041-conductor-webhook-hardening.md),
  [ADR-0131](0131-conductor-pure-engine-decides-the-kernel-performs.md),
  [ADR-0133](0133-long-running-tool-tasks-behind-a-task-store-seam.md) (the same lease pattern for tasks).
