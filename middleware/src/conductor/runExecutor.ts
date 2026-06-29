import { randomUUID } from 'node:crypto';

import { nextStep } from '@omadia/conductor-core';
import type { JsonObject, JsonValue, Step, WorkflowGraph } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRun, ConductorRunStore, TriggerKind } from './runStore.js';
import { RunLeaseLostError } from './runStore.js';
import type { ConductorAwaitStore } from './awaitStore.js';
import type { StepEffects } from './stepEffects.js';

export class WorkflowNotFoundError extends Error {}
export class WorkflowDisabledError extends Error {}
export class WorkflowNotPublishedError extends Error {}
export class AwaitNotPendingError extends Error {}

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
  private readonly log: (msg: string) => void;

  constructor(deps: {
    workflowStore: ConductorWorkflowStore;
    runStore: ConductorRunStore;
    awaitStore: ConductorAwaitStore;
    effects: StepEffects;
    log?: (msg: string) => void;
  }) {
    this.workflowStore = deps.workflowStore;
    this.runStore = deps.runStore;
    this.awaitStore = deps.awaitStore;
    this.effects = deps.effects;
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
          await this.openHumanAwait(runId, step, context, lease);
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
    await this.awaitStore.recordResponse(awaitId, responderId, response);
    const won = await this.awaitStore.close(awaitId, 'resolved');
    if (!won) throw new AwaitNotPendingError(`await '${awaitId}' was already resolved`);

    const { graph, run } = await this.loadRunGraph(aw.runId);
    const lease = randomUUID();
    await this.runStore.acquireLease(aw.runId, lease); // take over the parked run's lease
    const decision = nextStep(graph, aw.stepId, response, run.context);
    const context = this.accumulate(run.context, aw.stepId, response);
    const seq = (await this.runStore.stepsForRun(aw.runId)).length;
    const next = await this.applyDecision(aw.runId, seq, aw.stepId, { kind: 'human', resolvedUserId: responderId }, decision, context, lease);
    if (next) return this.driveFrom(aw.runId, graph, next, context, lease);
    return (await this.runStore.get(aw.runId)) ?? run;
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

  private async openHumanAwait(runId: string, step: Step, context: JsonObject, lease: string): Promise<void> {
    const h = step.human;
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
