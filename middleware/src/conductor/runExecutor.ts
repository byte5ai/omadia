import { randomUUID } from 'node:crypto';

import { nextStep } from '@omadia/conductor-core';
import type { JsonObject, JsonValue, Step, WorkflowGraph } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRun, ConductorRunStore, TriggerKind } from './runStore.js';
import { RunLeaseLostError } from './runStore.js';
import type { ConductorAwaitStore } from './awaitStore.js';
import type { StepEffects } from './stepEffects.js';
import type { DevJobStepPort, DevJobTerminalOutcome } from './devJobStepEffect.js';
import { isDevJobStep, buildDevJobPrincipalRef, parseDevJobPrincipalRef } from './devJobStepEffect.js';
import { canonicalizePrincipalId } from './principalId.js';

export class WorkflowNotFoundError extends Error {}
export class WorkflowDisabledError extends Error {}
export class WorkflowNotPublishedError extends Error {}
export class AwaitNotPendingError extends Error {}
/** A responder who is not a current holder tried to resolve an await (authorization gate). */
export class AwaitResponderNotHolderError extends Error {}
/** A dev-job step was reached, or a dev-job outcome arrived, but no dev-job port was wired. */
export class DevJobPortUnavailableError extends Error {}

export interface PreviewStep {
  stepId: string;
  kind: 'agent' | 'action' | 'human';
  actor: string;
  postcondition: string;
  transition: string | null;
  result: JsonValue;
}

export interface PreviewResult {
  status: 'completed' | 'failed';
  steps: PreviewStep[];
  context: JsonObject;
}

const MAX_STEPS = 1000;

function asObject(v: JsonValue | undefined): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}

/**
 * A human response counts as approval unless it is explicitly `{ approved: false }` (the reject
 * button's payload). Fail-open by design: an absent/garbage/missing flag counts as approval, and
 * only a strict boolean `false` is a reject (the inbox sends a typed boolean). A guard step's
 * postcondition can still inspect the raw `responses` map for finer policy.
 */
function isApproved(response: JsonValue): boolean {
  return !(
    typeof response === 'object' &&
    response !== null &&
    !Array.isArray(response) &&
    (response as JsonObject).approved === false
  );
}

/** Parse an ISO-8601 duration (PT6H, PT24H, PT30M, P1D, P1DT2H) to milliseconds, or null. */
export function parseIsoDurationMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  const ms = (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}

/**
 * Owns run advancement: the engine (`@omadia/conductor-core`) decides the path; this executor
 * performs per-step I/O (via StepEffects) and persists each step + accumulated context before
 * advancing (FR-004). A human step opens a durable await and parks the run as `waiting`; when a
 * human responds (resolveAwait) or the deadline passes (expireAwait) the run resumes.
 */
export class ConductorRunExecutor {
  private readonly workflowStore: ConductorWorkflowStore;
  private readonly runStore: ConductorRunStore;
  private readonly awaitStore: ConductorAwaitStore;
  private readonly effects: StepEffects;
  /** Late-bound role→holders resolver — the required responders for a quorum='all' role await.
   *  Required (not optional) so a role-based 'all' can never silently degrade to 'any' when unwired. */
  private readonly resolveRoleHolders: (roleKey: string) => Promise<string[]>;
  /** Optional dev-job port (Epic #470 W3). Absent ⇒ the feature is off: a dev-job step falls
   *  through to the normal action effect and `resolveDevJobAwait` throws if ever called. */
  private readonly devJob?: DevJobStepPort;
  private readonly log: (msg: string) => void;

  constructor(deps: {
    workflowStore: ConductorWorkflowStore;
    runStore: ConductorRunStore;
    awaitStore: ConductorAwaitStore;
    effects: StepEffects;
    resolveRoleHolders: (roleKey: string) => Promise<string[]>;
    devJob?: DevJobStepPort;
    log?: (msg: string) => void;
  }) {
    this.workflowStore = deps.workflowStore;
    this.runStore = deps.runStore;
    this.awaitStore = deps.awaitStore;
    this.effects = deps.effects;
    this.resolveRoleHolders = deps.resolveRoleHolders;
    this.devJob = deps.devJob;
    this.log = deps.log ?? (() => undefined);
  }

  async startRun(input: {
    slug: string;
    payload: JsonObject;
    triggerKind?: TriggerKind;
    triggerSource?: JsonValue | null;
    isDryRun?: boolean;
    awaitCompletion?: boolean;
  }): Promise<ConductorRun> {
    const wf = await this.workflowStore.getBySlug(input.slug);
    if (!wf) throw new WorkflowNotFoundError(`workflow '${input.slug}' not found`);
    if (wf.status === 'disabled') {
      this.log(`[conductor] suppressed trigger for disabled workflow '${input.slug}'`);
      throw new WorkflowDisabledError(`workflow '${input.slug}' is disabled`);
    }
    if (!wf.activeVersionId) throw new WorkflowNotPublishedError(`workflow '${input.slug}' has no active version`);
    const version = await this.workflowStore.getVersion(wf.activeVersionId);
    if (!version) throw new WorkflowNotPublishedError(`active version of '${input.slug}' missing`);

    const lease = randomUUID();
    const run = await this.runStore.create({
      workflowVersionId: version.id,
      entryStepId: version.graph.entryStepId,
      context: input.payload,
      triggerKind: input.triggerKind ?? 'manual',
      triggerSource: input.triggerSource ?? null,
      isDryRun: input.isDryRun ?? false,
      claimedBy: lease,
    });

    if (input.awaitCompletion) {
      return this.driveFrom(run.id, version.graph, version.graph.entryStepId, input.payload, lease);
    }
    const graph = version.graph;
    void this.driveFrom(run.id, graph, graph.entryStepId, input.payload, lease).catch((err) => {
      this.log(`[conductor] run ${run.id} drive crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return run;
  }

  /**
   * Drive a run forward from `startStepId`. Human steps open an await and park. Every step/park
   * write is fenced on `lease` (the driver's claimed_by token): if a resume worker has taken the
   * run over (because this drive stalled past staleMs), the next write throws RunLeaseLostError and
   * this superseded driver stops — the new owner is now driving, so the run is never double-driven.
   */
  private async driveFrom(
    runId: string,
    graph: WorkflowGraph,
    startStepId: string,
    startContext: JsonObject,
    lease: string,
  ): Promise<ConductorRun> {
    let context: JsonObject = { ...startContext };
    let currentStepId: string | null = startStepId;
    let seq = (await this.runStore.stepsForRun(runId)).length;

    try {
      while (currentStepId && seq < MAX_STEPS) {
        const stepId: string = currentStepId;
        const step = graph.steps.find((s) => s.id === stepId);
        if (!step) {
          await this.runStore.recordStepAndAdvance({
            runId, seq, stepId, actor: null, postconditionOutcome: 'n/a', transitionTaken: null,
            nextStepId: null, context, status: 'failed', claimedBy: lease,
          });
          break;
        }

        // Human step → durable await + park; resolveAwait/expireAwait resume the run.
        if (step.kind === 'human') {
          const parked = await this.openHumanAwait(runId, step, context, lease);
          if (parked) return (await this.runStore.get(runId)) ?? (await this.requireRun(runId));
          // No reachable holder → don't hang. Take the step's in-graph fallback (FR-024), else fail.
          const fb = step.fallbackTransitionId ? graph.transitions.find((tr) => tr.id === step.fallbackTransitionId) : undefined;
          await this.runStore.recordStepAndAdvance({
            runId, seq, stepId, actor: { kind: 'human', noHolder: true },
            postconditionOutcome: 'unmet', transitionTaken: fb?.id ?? null, nextStepId: fb?.target ?? null,
            context, status: fb ? 'running' : 'failed', claimedBy: lease,
          });
          if (!fb) break;
          currentStepId = fb.target;
          seq += 1;
          continue;
        }

        // Dev-job step (Epic #470 W3) → launch one dev job, open a durable await bound to it,
        // and park. The whole minutes-long job is ONE opaque step; `resolveDevJobAwait` resumes
        // the run when the job reaches a terminal state, and the workflow branches on the
        // outcome. Only active when a dev-job port is wired — otherwise it falls through to the
        // normal action effect below (a `dev.job` actionId with no port simply fails there).
        if (this.devJob && isDevJobStep(step)) {
          await this.openDevJobAwait(runId, step, context, lease);
          return (await this.runStore.get(runId)) ?? (await this.requireRun(runId));
        }

        let exec;
        try {
          exec = step.kind === 'agent'
            ? await this.effects.runAgentStep(step, context, { runId })
            : await this.effects.runActionStep(step, context, { runId });
        } catch (err) {
          this.log(`[conductor] run ${runId} step '${stepId}' threw: ${err instanceof Error ? err.message : String(err)}`);
          await this.runStore.recordStepAndAdvance({
            runId, seq, stepId, actor: { kind: step.kind, ref: step.agentId ?? step.actionId ?? null },
            postconditionOutcome: 'n/a', transitionTaken: null, nextStepId: null, context, status: 'failed', claimedBy: lease,
          });
          break;
        }

        const decision = nextStep(graph, stepId, exec.result, context);
        context = this.accumulate(context, stepId, exec.result);
        currentStepId = await this.applyDecision(runId, seq, stepId, exec.actor, decision, context, lease);
        if (currentStepId) seq += 1;
      }
    } catch (err) {
      if (err instanceof RunLeaseLostError) {
        this.log(`[conductor] run ${runId} drive yielded: ${err.message}`);
        return (await this.runStore.get(runId)) ?? (await this.requireRun(runId));
      }
      throw err;
    }

    return (await this.runStore.get(runId)) ?? (await this.requireRun(runId));
  }

  /**
   * Re-drive a run left 'running' by a process restart (US2 / SC-002). The run's
   * `current_step_id` points at the next not-yet-executed step — `recordStepAndAdvance`
   * persists the COMPLETED step and only then advances the pointer — so re-driving from
   * there never re-runs a step that was already recorded. The single residual gap is a
   * step whose effect ran but whose record never committed (a crash mid-effect): that one
   * step is re-executed, the inherent at-least-once limit of crash-resume without effect
   * idempotency keys. Called only by the resume worker, after it has claimed the run.
   */
  async resumeRun(runId: string, lease: string): Promise<ConductorRun> {
    const run = await this.requireRun(runId);
    if (run.status !== 'running') return run; // completed/parked between claim and resume
    if (!run.currentStepId) {
      // 'running' with no next step is an inconsistent state — finalize rather than hang.
      const seq = (await this.runStore.stepsForRun(runId)).length;
      await this.runStore.recordStepAndAdvance({
        runId, seq, stepId: '(resume)', actor: { kind: 'resume', reason: 'no_current_step' },
        postconditionOutcome: 'n/a', transitionTaken: null, nextStepId: null, context: run.context, status: 'failed', claimedBy: lease,
      });
      return (await this.runStore.get(runId)) ?? run;
    }
    const { graph } = await this.loadRunGraph(runId);
    this.log(`[conductor] resuming run ${runId} at step '${run.currentStepId}'`);
    return this.driveFrom(runId, graph, run.currentStepId, run.context, lease);
  }

  /** A human responded — resolve the await and resume the run. */
  async resolveAwait(awaitId: string, responderId: string, response: JsonValue): Promise<ConductorRun> {
    const aw = await this.awaitStore.get(awaitId);
    if (!aw || aw.status !== 'waiting') throw new AwaitNotPendingError(`await '${awaitId}' is not pending`);

    // Holders resolved LIVE (baton moves re-target) and canonicalized so a lowercased-email responder
    // (the channel layer always lowercases) matches an operator-typed holder. Used for BOTH the
    // authorization gate below and the quorum='all' completeness check.
    const required = (
      aw.principalKind === 'role' ? await this.resolveRoleHolders(aw.principalRef) : [aw.principalRef]
    ).map(canonicalizePrincipalId);
    const requiredSet = new Set(required);
    const responder = canonicalizePrincipalId(responderId);

    // Authorization gate: only a current holder may resolve an await. Without this, the Action.Submit
    // payload (client-controllable, carries only awaitId) let any recipient of the card resolve a step
    // they don't own — including non-holders in a shared chat (review: Forge HIGH-1 / Claude M1).
    if (!requiredSet.has(responder)) {
      throw new AwaitResponderNotHolderError(`responder '${responderId}' is not a holder of await '${awaitId}'`);
    }

    await this.awaitStore.recordResponse(awaitId, responder, response);

    // Quorum: 'any' resumes on the first response (feeding that response on). 'all' records each
    // response and resumes only once EVERY current holder has answered — holders resolved live, so a
    // baton move correctly changes who is required. The aggregate is fed to the engine for 'all'.
    let stepResult: JsonValue = response;
    if (aw.quorum === 'all') {
      const responses = await this.awaitStore.listResponses(awaitId);
      const respondedRequired = new Set(
        responses.map((r) => canonicalizePrincipalId(r.responderId)).filter((id) => requiredSet.has(id)),
      );
      // Empty `required` (a role with no current holders, e.g. all batons moved away) is NOT
      // vacuously complete — that would let one stray response resolve a no-holder await. Such a
      // run stays waiting until its deadline fires the fallback (FR-024).
      const complete = required.length > 0 && required.every((h) => respondedRequired.has(h));
      if (!complete) {
        this.log(`[conductor] await ${awaitId} quorum 'all': ${respondedRequired.size}/${required.length} required responded`);
        return (await this.runStore.get(aw.runId)) ?? (await this.requireRun(aw.runId));
      }
      // Aggregate over CURRENT required holders only — a holder who lost the baton (or whose stale
      // answer predates a baton move) must not skew `approved` or appear in `responses` (review C#1).
      const counted = responses.filter((r) => requiredSet.has(canonicalizePrincipalId(r.responderId)));
      stepResult = {
        quorum: 'all',
        approved: counted.every((r) => isApproved(r.response)),
        responses: Object.fromEntries(counted.map((r) => [canonicalizePrincipalId(r.responderId), r.response])),
      };
    }

    const won = await this.awaitStore.close(awaitId, 'resolved');
    if (!won) throw new AwaitNotPendingError(`await '${awaitId}' was already resolved`);

    const { graph, run } = await this.loadRunGraph(aw.runId);
    const lease = randomUUID();
    await this.runStore.acquireLease(aw.runId, lease); // take over the parked run's lease
    const decision = nextStep(graph, aw.stepId, stepResult, run.context);
    const context = this.accumulate(run.context, aw.stepId, stepResult);
    const seq = (await this.runStore.stepsForRun(aw.runId)).length;
    const next = await this.applyDecision(aw.runId, seq, aw.stepId, { kind: 'human', quorum: aw.quorum, resolvedUserId: responder }, decision, context, lease);
    if (next) return this.driveFrom(aw.runId, graph, next, context, lease);
    return (await this.runStore.get(aw.runId)) ?? run;
  }

  /**
   * A dev job reached a terminal state — resolve its holding await and resume the run
   * SYNCHRONOUSLY (the redesign: the whole job is ONE opaque step; its terminal outcome is the
   * step result fed to `nextStep`). Mirrors `resolveAwait` minus the human authorization gate —
   * a dev job has no human responder, so there is nobody to authorize.
   *
   * Idempotent — a duplicate terminal event resolves the await AT MOST ONCE, so the run never
   * double-advances: the `status !== 'waiting'` guard skips an already-resolved await, and the
   * atomic `close` CAS makes the winner unique under a genuine race. An unknown/unbound job (no
   * `conductor_await_id`) is a no-op — a non-Conductor job simply has no run to resume.
   */
  async resolveDevJobAwait(outcome: DevJobTerminalOutcome): Promise<ConductorRun | null> {
    const port = this.devJob;
    if (!port) {
      throw new DevJobPortUnavailableError(`dev-job outcome for job '${outcome.jobId}' but no dev-job port wired`);
    }
    const awaitId = await port.awaitIdForJob(outcome.jobId);
    if (!awaitId) return null; // not a Conductor-driven job (or link missing) — nothing to resume

    const aw = await this.awaitStore.get(awaitId);
    // Already resolved (a duplicate terminal event) or gone → idempotent no-op. Return the run's
    // current state so a caller can observe where it landed, or null if the await is unknown.
    if (!aw || aw.status !== 'waiting') {
      return aw ? ((await this.runStore.get(aw.runId)) ?? null) : null;
    }

    const stepResult: JsonValue = {
      jobId: outcome.jobId,
      status: outcome.status,
      prUrl: outcome.prUrl ?? null,
      branch: outcome.branch ?? null,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
    };

    // Atomic waiting → resolved. If a concurrent resolver already won, `close` returns false and
    // we must NOT advance the run a second time — return its current state instead.
    const won = await this.awaitStore.close(awaitId, 'resolved');
    if (!won) return (await this.runStore.get(aw.runId)) ?? null;

    const { graph, run } = await this.loadRunGraph(aw.runId);
    const lease = randomUUID();
    await this.runStore.acquireLease(aw.runId, lease); // take over the parked run's lease
    const decision = nextStep(graph, aw.stepId, stepResult, run.context);
    const context = this.accumulate(run.context, aw.stepId, stepResult);
    const seq = (await this.runStore.stepsForRun(aw.runId)).length;
    const next = await this.applyDecision(
      aw.runId, seq, aw.stepId, { kind: 'dev_job', jobId: outcome.jobId, status: outcome.status }, decision, context, lease,
    );
    if (next) return this.driveFrom(aw.runId, graph, next, context, lease);
    return (await this.runStore.get(aw.runId)) ?? run;
  }

  /**
   * Reconciliation sweep for the terminal-before-bind lost-wakeup (Epic #470 W3). The
   * `DevJobOutcomeEmitter` is edge-triggered and unbuffered, so a job that reaches a terminal
   * state BEFORE its await was bound — a crash between `launch` and `bindAwait`, or the
   * microsecond window between `create` and `bindAwait` — never re-emits, and neither
   * `claimResumableRuns` (only `running` runs) nor the deadline worker (dev-job awaits have no
   * deadline) would ever recover the parked run. Left unrecovered the run hangs forever.
   *
   * The sweep re-derives the wakeup from durable state: for every still-waiting dev-job await it
   * asks the port whether the bound job is already terminal, and if so feeds that outcome through
   * the idempotent `resolveDevJobAwait`. Safe to run repeatedly and concurrently with a live emit
   * — the await's status guard + close CAS make the winner unique. Returns the number resolved.
   * Wire-nothing: W4 schedules this on a timer; it is a no-op until the dev-job port is present.
   */
  async reconcileTerminalDevJobAwaits(limit = 200): Promise<number> {
    const port = this.devJob;
    if (!port) return 0;
    const waiting = await this.awaitStore.listWaitingDevJobAwaits(limit);
    let resolved = 0;
    for (const aw of waiting) {
      const jobId = parseDevJobPrincipalRef(aw.principalRef);
      if (!jobId) continue; // not a dev-job principal (defensive) — leave it for the human paths
      const outcome = await port.terminalOutcomeForJob(jobId);
      if (!outcome) continue; // still running / unknown — nothing to resume yet
      await this.resolveDevJobAwait(outcome);
      resolved += 1;
    }
    return resolved;
  }

  /** A deadline passed with no response — close the await and fire the in-graph fallback (FR-017). */
  async expireAwait(awaitId: string): Promise<void> {
    const aw = await this.awaitStore.get(awaitId);
    if (!aw || aw.status !== 'waiting') return;
    const won = await this.awaitStore.close(awaitId, 'timed_out');
    if (!won) return;

    const { graph, run } = await this.loadRunGraph(aw.runId);
    const lease = randomUUID();
    await this.runStore.acquireLease(aw.runId, lease); // take over the parked run's lease
    const seq = (await this.runStore.stepsForRun(aw.runId)).length;
    const fallback = aw.fallbackTransitionId ? graph.transitions.find((tr) => tr.id === aw.fallbackTransitionId) : undefined;
    if (!fallback) {
      await this.runStore.recordStepAndAdvance({
        runId: aw.runId, seq, stepId: aw.stepId, actor: { kind: 'human', timedOut: true },
        postconditionOutcome: 'unmet', transitionTaken: null, nextStepId: null, context: run.context, status: 'failed', claimedBy: lease,
      });
      return;
    }
    await this.runStore.recordStepAndAdvance({
      runId: aw.runId, seq, stepId: aw.stepId, actor: { kind: 'human', timedOut: true },
      postconditionOutcome: 'unmet', transitionTaken: fallback.id, nextStepId: fallback.target, context: run.context, status: 'running', claimedBy: lease,
    });
    this.log(`[conductor] await ${awaitId} timed out → fallback '${fallback.id}' (run ${aw.runId})`);
    await this.driveFrom(aw.runId, graph, fallback.target, run.context, lease);
  }

  /**
   * Dry-run / preview (US8 / FR-029): simulate the workflow path in memory with NO persistence
   * and NO side effects — no conductor_runs/awaits rows, no real notification, no durable await.
   * Human steps are answered inline (supplied `humanResponses[stepId]`, default `{approved:true}`);
   * agent steps run a real turn; action steps are stubbed (irreversible connector actions are not
   * executed). Returns the full simulated step path so the operator gains confidence before activating.
   */
  async previewRun(slug: string, payload: JsonObject, humanResponses: Record<string, JsonValue> = {}): Promise<PreviewResult> {
    const wf = await this.workflowStore.getBySlug(slug);
    if (!wf) throw new WorkflowNotFoundError(`workflow '${slug}' not found`);
    if (!wf.activeVersionId) throw new WorkflowNotPublishedError(`workflow '${slug}' has no active version`);
    const version = await this.workflowStore.getVersion(wf.activeVersionId);
    if (!version) throw new WorkflowNotPublishedError(`active version of '${slug}' missing`);
    const graph = version.graph;

    let context: JsonObject = { ...payload };
    let currentStepId: string | null = graph.entryStepId;
    const steps: PreviewStep[] = [];
    let status: 'completed' | 'failed' = 'completed';
    let guard = MAX_STEPS;

    while (currentStepId && guard-- > 0) {
      const stepId: string = currentStepId;
      const step = graph.steps.find((s) => s.id === stepId);
      if (!step) {
        status = 'failed';
        break;
      }

      let result: JsonValue;
      let actor: string;
      if (step.kind === 'human') {
        result = humanResponses[stepId] ?? { approved: true };
        actor = 'human (inline)';
      } else if (step.kind === 'agent') {
        const exec = await this.effects.runAgentStep(step, context, { runId: `preview:${slug}` });
        result = exec.result;
        actor = `agent:${step.agentId ?? '?'}`;
      } else {
        result = { simulated: true, actionId: step.actionId ?? null };
        actor = `action (stubbed):${step.actionId ?? '?'}`;
      }

      const decision = nextStep(graph, stepId, result, context);
      context = this.accumulate(context, stepId, result);
      steps.push({
        stepId,
        kind: step.kind,
        actor,
        postcondition: decision.postcondition,
        transition: decision.kind === 'advance' ? decision.transitionId : null,
        result,
      });

      if (decision.kind === 'advance') {
        currentStepId = decision.targetStepId;
      } else {
        status = decision.kind === 'complete' ? 'completed' : 'failed';
        currentStepId = null;
      }
    }

    return { status, steps, context };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Opens a durable await + parks the run. Returns false (without parking) when a role principal has
   *  NO current holder — nobody could answer, so the caller takes the step's fallback instead of
   *  hanging the run forever (FR-024). */
  private async openHumanAwait(runId: string, step: Step, context: JsonObject, lease: string): Promise<boolean> {
    const h = step.human;
    if (h?.principal.kind === 'role') {
      const holders = await this.resolveRoleHolders(h.principal.ref);
      if (holders.length === 0) {
        this.log(`[conductor] run ${runId} human step '${step.id}' role '${h.principal.ref}' has no current holder`);
        return false;
      }
    }
    const deadlineMs = parseIsoDurationMs(h?.deadline ?? null);
    const reminderMs = parseIsoDurationMs(h?.reminderInterval ?? null);
    // create() is idempotent (one open await per run+step), so a crash-and-resume between
    // create and park never doubles the await; park is fenced on the lease.
    await this.awaitStore.create({
      runId,
      stepId: step.id,
      principalKind: h?.principal.kind ?? 'role',
      principalRef: h?.principal.ref ?? '',
      channelType: h?.channel ?? 'teams',
      message: h?.message ?? '',
      quorum: h?.quorum ?? 'any',
      reminderIntervalMs: reminderMs,
      deadlineAt: deadlineMs ? new Date(Date.now() + deadlineMs) : null,
      fallbackTransitionId: step.fallbackTransitionId ?? null,
    });
    await this.runStore.park(runId, step.id, context, lease);
    this.log(`[conductor] run ${runId} awaiting human at step '${step.id}' (${h?.principal.kind}:${h?.principal.ref})`);
    return true;
  }

  /**
   * Launch ONE dev job for a dev-job step, open a durable await bound to it, and park the run —
   * the launch-side mirror of `openHumanAwait`. All I/O goes through the injected `DevJobStepPort`
   * so the deterministic engine stays pure.
   *
   * Exactly-one-job safety across a crash-and-resume: `port.launch` is contractually idempotent
   * per (runId, stepId), and `awaitStore.create` is idempotent per (run, step) via its partial
   * unique index — so re-driving this step (the run is still 'running' at this step until `park`
   * commits) re-uses the same job and the same await rather than doubling either. The await binds
   * to a synthetic `dev_job:<jobId>` principal (a dev job has no human holder) and carries no
   * deadline — the dev-job worker owns stall / wall-clock reaping, not Conductor.
   */
  private async openDevJobAwait(runId: string, step: Step, context: JsonObject, lease: string): Promise<void> {
    const port = this.devJob;
    if (!port) {
      throw new DevJobPortUnavailableError(`run ${runId}: dev-job step '${step.id}' reached but no dev-job port wired`);
    }
    const { jobId } = await port.launch({ runId, stepId: step.id, step, context });
    const aw = await this.awaitStore.create({
      runId,
      stepId: step.id,
      principalKind: 'user',
      principalRef: buildDevJobPrincipalRef(jobId),
      channelType: 'dev_job',
      message: '',
      quorum: 'any',
      reminderIntervalMs: null,
      deadlineAt: null,
      // Deliberately NULL (unlike openHumanAwait): a dev-job await carries no deadline, so
      // `expireAwait` never fires and an await-level fallback could never be read. Failure
      // branching for a dev-job step is expressed as ordinary GRAPH transitions on the outcome
      // (`step.fallbackTransitionId` + guards), which `resolveDevJobAwait` honours through
      // `nextStep`. Copying it onto the await too would be dead data that misleads authors into
      // thinking the await-level field is what catches a failed job.
      fallbackTransitionId: null,
    });
    await port.bindAwait(jobId, aw.id);
    await this.runStore.park(runId, step.id, context, lease);
    this.log(`[conductor] run ${runId} launched dev job ${jobId} at step '${step.id}' (await ${aw.id})`);
  }

  private accumulate(context: JsonObject, stepId: string, result: JsonValue): JsonObject {
    const prev = asObject(context.steps);
    return { ...context, steps: { ...prev, [stepId]: result } };
  }

  /** Persist a step's decision; returns the next step id to drive, or null if the run ended/parked. */
  private async applyDecision(
    runId: string,
    seq: number,
    stepId: string,
    actor: JsonValue,
    decision: ReturnType<typeof nextStep>,
    context: JsonObject,
    lease: string,
  ): Promise<string | null> {
    if (decision.kind === 'advance') {
      await this.runStore.recordStepAndAdvance({
        runId, seq, stepId, actor, postconditionOutcome: decision.postcondition, transitionTaken: decision.transitionId,
        nextStepId: decision.targetStepId, context, status: 'running', claimedBy: lease,
      });
      return decision.targetStepId;
    }
    if (decision.kind === 'complete') {
      await this.runStore.recordStepAndAdvance({
        runId, seq, stepId, actor, postconditionOutcome: decision.postcondition, transitionTaken: null,
        nextStepId: null, context, status: 'completed', claimedBy: lease,
      });
      return null;
    }
    this.log(`[conductor] run ${runId} stuck at '${stepId}': ${decision.message}`);
    await this.runStore.recordStepAndAdvance({
      runId, seq, stepId, actor, postconditionOutcome: decision.postcondition, transitionTaken: null,
      nextStepId: stepId, context, status: 'failed', claimedBy: lease,
    });
    return null;
  }

  private async loadRunGraph(runId: string): Promise<{ graph: WorkflowGraph; run: ConductorRun }> {
    const run = await this.requireRun(runId);
    const version = await this.workflowStore.getVersion(run.workflowVersionId);
    if (!version) throw new WorkflowNotPublishedError(`version for run '${runId}' missing`);
    return { graph: version.graph, run };
  }

  private async requireRun(runId: string): Promise<ConductorRun> {
    const run = await this.runStore.get(runId);
    if (!run) throw new WorkflowNotFoundError(`run '${runId}' not found`);
    return run;
  }
}
