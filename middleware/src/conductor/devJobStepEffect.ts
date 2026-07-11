import type { JsonObject, JsonValue, Step } from '@omadia/conductor-core';

/**
 * Epic #470 W3 — the dev-job Conductor step.
 *
 * A dev job runs for minutes and is modelled as ONE opaque Conductor step: when the
 * executor reaches it, it starts a single dev job, opens a durable await bound to that
 * job, and parks the run `waiting` (mirroring `openHumanAwait`). When the job reaches a
 * terminal state a resolver feeds the terminal outcome back through
 * `ConductorRunExecutor.resolveDevJobAwait`, which resumes the run synchronously via
 * `nextStep`. The terminal outcome becomes the step's `result`, so the WORKFLOW — not this
 * effect — decides what happens next via its transitions/guards (a done/failed/gate/deny
 * job all resume the run; only the branch taken differs).
 *
 * The step reuses the existing `action` step path (a reserved `actionId`) so no
 * conductor-core schema change is needed. Every side effect (launch, await binding, event
 * subscription) goes through the injected ports below, keeping the deterministic engine
 * pure. The conductor layer never imports devplatform concretely — the devplatform binding
 * (`devJobConductorBridge.ts`) implements these interfaces and the boot wiring binds them.
 */

/** Reserved `actionId` that marks an `action` step as a dev-job step. Reusing the action
 *  path is deliberate: it avoids adding a new `StepKind` (and so a conductor-core schema
 *  migration) just to launch a job. */
export const DEV_JOB_ACTION_ID = 'dev.job';

/** True when a step is a dev-job step — an `action` step carrying the reserved `actionId`.
 *  Backward compatible: without the port wired, such a step falls through to the normal
 *  action effect, so existing graphs are unaffected. */
export function isDevJobStep(step: Step): boolean {
  return step.kind === 'action' && step.actionId === DEV_JOB_ACTION_ID;
}

/** Prefix of the synthetic `principalRef` a dev-job await carries (a dev job has no human
 *  holder). The jobId is recoverable from the await alone, so the reconciliation sweep needs
 *  no extra column. Defined once here and shared by open + reconcile. */
export const DEV_JOB_PRINCIPAL_PREFIX = 'dev_job:';

/** Build the synthetic principalRef for a dev-job await. */
export function buildDevJobPrincipalRef(jobId: string): string {
  return `${DEV_JOB_PRINCIPAL_PREFIX}${jobId}`;
}

/** Recover the jobId from a dev-job await's principalRef, or `null` if it is not one. */
export function parseDevJobPrincipalRef(principalRef: string): string | null {
  if (!principalRef.startsWith(DEV_JOB_PRINCIPAL_PREFIX)) return null;
  const jobId = principalRef.slice(DEV_JOB_PRINCIPAL_PREFIX.length);
  return jobId.length > 0 ? jobId : null;
}

/**
 * Terminal outcome of a dev job, fed back to the parked Conductor step as its `result`.
 * `status` is a terminal DevJobStatus (`done`/`failed`/`cancelled`/`stalled`/
 * `budget_exceeded`) — kept as a plain `string` so the conductor layer needs no devplatform
 * import. The effect reports these fields faithfully; guards read them (e.g.
 * `stepResult.status == 'done'`, `stepResult.prUrl`) to choose the next transition.
 */
export interface DevJobTerminalOutcome {
  jobId: string;
  status: string;
  prUrl?: string | null;
  branch?: string | null;
  /** the runner's `DevJobResult` (carries `outcome` + any gate/deny detail), verbatim. */
  result?: JsonValue | null;
  error?: string | null;
}

/**
 * Conductor-side port: start a dev job for a step and link it to its holding await.
 *
 * `launch` MUST be idempotent per `(runId, stepId)`: a crash between `launch` and `park`
 * re-drives this step, so a second `launch` for the same run+step must return the SAME
 * `jobId` rather than starting a second job. That contract, paired with the idempotent
 * `awaitStore.create`, is what keeps a dev-job step to exactly one job.
 */
export interface DevJobStepPort {
  launch(input: { runId: string; stepId: string; step: Step; context: JsonObject }): Promise<{ jobId: string }>;
  /** Persist the await↔job link (`dev_jobs.conductor_await_id`) so the resolver can find it. */
  bindAwait(jobId: string, awaitId: string): Promise<void>;
  /** The await bound to a job, or `null` when the job is not conductor-driven. */
  awaitIdForJob(jobId: string): Promise<string | null>;
  /**
   * The job's terminal outcome if it is ALREADY terminal, else `null` (still running / unknown).
   * The recovery path for the terminal-before-bind lost-wakeup: the `DevJobOutcomeEmitter` is
   * edge-triggered and unbuffered, so a job that finished before its await existed (a crash, or
   * the microsecond window between `create` and `bindAwait`) never re-emits. The reconciliation
   * sweep polls this for every still-waiting dev-job await and resumes the ones already done.
   */
  terminalOutcomeForJob(jobId: string): Promise<DevJobTerminalOutcome | null>;
}

/** A source of terminal dev-job outcomes — an event-bus tail or a `finalizeDevJob` hook.
 *  It MUST emit only for TERMINAL jobs; emitting mid-job would resume the run prematurely. */
export interface DevJobOutcomeSource {
  onTerminal(handler: (outcome: DevJobTerminalOutcome) => void | Promise<void>): () => void;
}

/** The executor surface the resolver drives. Decouples the wiring factory from the concrete
 *  `ConductorRunExecutor` class (and keeps it trivially fakeable in tests). */
export interface DevJobAwaitResolver {
  resolveDevJobAwait(outcome: DevJobTerminalOutcome): Promise<unknown>;
}

/**
 * Wiring factory: tie a terminal-outcome source to the executor. Returns an unsubscribe
 * handle. The boot wiring calls this — it does NOT touch boot itself. A resolve failure is
 * logged and swallowed, never thrown back into the source's emit (one job's resolve crash
 * must not tear down the subscription or block sibling outcomes).
 */
export function subscribeDevJobResolver(deps: {
  resolver: DevJobAwaitResolver;
  source: DevJobOutcomeSource;
  log?: (msg: string) => void;
}): () => void {
  return deps.source.onTerminal((outcome) => {
    void Promise.resolve(deps.resolver.resolveDevJobAwait(outcome)).catch((err) => {
      deps.log?.(
        `[conductor] dev-job resolve failed for job ${outcome.jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
}
