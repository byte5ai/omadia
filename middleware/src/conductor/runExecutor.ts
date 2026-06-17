import { nextStep } from '@omadia/conductor-core';
import type { JsonObject, JsonValue, WorkflowGraph } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRun, ConductorRunStore, TriggerKind } from './runStore.js';
import type { StepEffects } from './stepEffects.js';

export class WorkflowNotFoundError extends Error {}
export class WorkflowDisabledError extends Error {}
export class WorkflowNotPublishedError extends Error {}

const MAX_STEPS = 1000;

function asObject(v: JsonValue | undefined): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
}

/**
 * Owns run advancement: the engine (`@omadia/conductor-core`) decides the path; this executor
 * performs the per-step I/O (via StepEffects) and persists each step + the run's accumulated
 * context before advancing (FR-004). Human steps park the run as `waiting` (the durable-await
 * substrate lands in a later phase); agent/action steps run to completion deterministically.
 */
export class ConductorRunExecutor {
  private readonly workflowStore: ConductorWorkflowStore;
  private readonly runStore: ConductorRunStore;
  private readonly effects: StepEffects;
  private readonly log: (msg: string) => void;

  constructor(deps: {
    workflowStore: ConductorWorkflowStore;
    runStore: ConductorRunStore;
    effects: StepEffects;
    log?: (msg: string) => void;
  }) {
    this.workflowStore = deps.workflowStore;
    this.runStore = deps.runStore;
    this.effects = deps.effects;
    this.log = deps.log ?? (() => undefined);
  }

  async startRun(input: {
    slug: string;
    payload: JsonObject;
    triggerKind?: TriggerKind;
    triggerSource?: JsonValue | null;
    isDryRun?: boolean;
  }): Promise<ConductorRun> {
    const wf = await this.workflowStore.getBySlug(input.slug);
    if (!wf) throw new WorkflowNotFoundError(`workflow '${input.slug}' not found`);
    if (wf.status === 'disabled') {
      // FR-009: a trigger for a disabled workflow starts no run and is logged.
      this.log(`[conductor] suppressed trigger for disabled workflow '${input.slug}'`);
      throw new WorkflowDisabledError(`workflow '${input.slug}' is disabled`);
    }
    if (!wf.activeVersionId) throw new WorkflowNotPublishedError(`workflow '${input.slug}' has no active version`);

    const version = await this.workflowStore.getVersion(wf.activeVersionId);
    if (!version) throw new WorkflowNotPublishedError(`active version of '${input.slug}' missing`);

    const run = await this.runStore.create({
      workflowVersionId: version.id,
      entryStepId: version.graph.entryStepId,
      context: input.payload,
      triggerKind: input.triggerKind ?? 'manual',
      triggerSource: input.triggerSource ?? null,
      isDryRun: input.isDryRun ?? false,
    });

    return this.drive(run, version.graph);
  }

  private async drive(run: ConductorRun, graph: WorkflowGraph): Promise<ConductorRun> {
    let context: JsonObject = { ...run.context };
    let currentStepId: string | null = run.currentStepId;
    let seq = 0;

    while (currentStepId && seq < MAX_STEPS) {
      const stepId: string = currentStepId;
      const step = graph.steps.find((s) => s.id === stepId);
      if (!step) {
        await this.runStore.recordStepAndAdvance({
          runId: run.id, seq, stepId, actor: null,
          postconditionOutcome: 'n/a', transitionTaken: null,
          nextStepId: null, context, status: 'failed',
        });
        break;
      }

      // Human steps: park the run (durable-await substrate is a later phase).
      if (step.kind === 'human') {
        await this.runStore.recordStepAndAdvance({
          runId: run.id, seq, stepId,
          actor: { kind: 'human', principal: step.human?.principal ?? null },
          postconditionOutcome: 'n/a', transitionTaken: null,
          nextStepId: stepId, context, status: 'waiting',
        });
        this.log(`[conductor] run ${run.id} parked at human step '${stepId}' (awaits not yet wired)`);
        break;
      }

      let exec;
      try {
        exec = step.kind === 'agent'
          ? await this.effects.runAgentStep(step, context)
          : await this.effects.runActionStep(step, context);
      } catch (err) {
        this.log(`[conductor] run ${run.id} step '${stepId}' threw: ${err instanceof Error ? err.message : String(err)}`);
        await this.runStore.recordStepAndAdvance({
          runId: run.id, seq, stepId,
          actor: { kind: step.kind, ref: step.agentId ?? step.actionId ?? null },
          postconditionOutcome: 'n/a', transitionTaken: null,
          nextStepId: null, context, status: 'failed',
        });
        break;
      }

      const decision = nextStep(graph, stepId, exec.result, context);

      // Accumulate this step's result under context.steps[stepId] for later guards.
      const prevSteps = asObject(context.steps);
      context = { ...context, steps: { ...prevSteps, [stepId]: exec.result } };

      if (decision.kind === 'advance') {
        await this.runStore.recordStepAndAdvance({
          runId: run.id, seq, stepId, actor: exec.actor,
          postconditionOutcome: decision.postcondition, transitionTaken: decision.transitionId,
          nextStepId: decision.targetStepId, context, status: 'running',
        });
        currentStepId = decision.targetStepId;
        seq += 1;
      } else if (decision.kind === 'complete') {
        await this.runStore.recordStepAndAdvance({
          runId: run.id, seq, stepId, actor: exec.actor,
          postconditionOutcome: decision.postcondition, transitionTaken: null,
          nextStepId: null, context, status: 'completed',
        });
        currentStepId = null;
      } else {
        this.log(`[conductor] run ${run.id} stuck at '${stepId}': ${decision.message}`);
        await this.runStore.recordStepAndAdvance({
          runId: run.id, seq, stepId, actor: exec.actor,
          postconditionOutcome: decision.postcondition, transitionTaken: null,
          nextStepId: stepId, context, status: 'failed',
        });
        currentStepId = null;
      }
    }

    const finalRun = await this.runStore.get(run.id);
    return finalRun ?? run;
  }
}
