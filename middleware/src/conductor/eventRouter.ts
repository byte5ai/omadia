import { randomUUID } from 'node:crypto';

import { evaluatePredicate } from '@omadia/conductor-core';
import type { JsonObject, Predicate, WorkflowGraph } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import { WorkflowDisabledError, WorkflowNotFoundError, type ConductorRunExecutor } from './runExecutor.js';
import { sanitizeRunContext } from './runContext.js';

export interface EmitResult {
  eventId: string;
  startedRuns: Array<{ workflowSlug: string; runId: string }>;
  matchedWorkflows: number;
  suppressed: Array<{ workflowSlug: string; reason: 'workflow_disabled' | 'workflow_not_found' }>;
  /** Matching workflows not started because their agent steps run as a
   *  different agent than the bot the channel event was addressed to. */
  skippedWorkflows: Array<{ workflowSlug: string; addressedAgent: string; stepAgents: string[] }>;
}

/**
 * The agent ids of a graph's agent steps that differ from `addressedAgent`.
 * Empty means every agent step may run for a message to that agent's bot.
 */
export function foreignAgentSteps(graph: WorkflowGraph, addressedAgent: string): string[] {
  const foreign = new Set<string>();
  for (const step of graph.steps ?? []) {
    if (step.kind === 'agent' && step.agentId !== undefined && step.agentId !== addressedAgent) {
      foreign.add(step.agentId);
    }
  }
  return [...foreign];
}

/**
 * Routes a domain event to the workflows that subscribe to it. A workflow subscribes via an
 * `event` trigger, or a `webhook` trigger (issue #437 — the inbound `/api/hooks/:endpointId`
 * route emits its endpoint's configured `eventId` here, exactly like any other domain event; a
 * `webhook` trigger is `event`'s sibling matched the same way, not a separate mechanism), in its
 * active version graph (an `eventId` plus an optional payload `filter` predicate). A matching
 * emit starts a run with the validated payload as initial context (US4 / FR-013), minus the
 * executor-owned keys (#1702 — see runContext.ts: an inbound payload must not
 * steer the loop budget or fake step results, and a trigger `filter` is
 * evaluated against the same sanitized context the run will actually see).
 * This is the kernel side of the Conductor Surface; a connector calls it (today via the operator emit route
 * and the inbound webhook route; `ctx.events.emit` for plugins is a follow-up).
 */
/** #2082 — told of every emitted event (agents' hooks listen on the same bus). */
export type EventObserver = (eventId: string, payload: JsonObject, eventKey: string) => void;

export class ConductorEventRouter {
  private readonly observers: EventObserver[] = [];

  constructor(
    private readonly deps: {
      workflowStore: ConductorWorkflowStore;
      executor: ConductorRunExecutor;
      /**
       * The agent a channel event was addressed to (its bot's owner), or
       * undefined for non-channel events and bots without an active agent.
       * When present, a workflow whose agent steps run as another agent is
       * not started for that event: the step-level origin rule would refuse
       * it anyway, so starting it only produced a failed run per message.
       */
      addressedAgent?: (eventId: string, payload: JsonObject) => string | undefined;
      log?: (msg: string) => void;
    },
  ) {}

  addObserver(observer: EventObserver): () => void {
    this.observers.push(observer);
    return () => {
      const i = this.observers.indexOf(observer);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  async emit(eventId: string, rawPayload: JsonObject, sourcePluginId?: string): Promise<EmitResult> {
    // #1702 — strip the executor-owned keys once, before anything reads the
    // payload, so the trigger filter and the run share one context. startRun
    // strips too (it is the chokepoint for every trigger kind); this call is
    // what keeps `filter` from matching on a key the run will not have.
    const payload = sanitizeRunContext(rawPayload);
    const eventKey = typeof payload['eventKey'] === 'string' ? payload['eventKey'] : randomUUID();
    for (const observer of this.observers) {
      try {
        observer(eventId, payload, eventKey);
      } catch (err) {
        this.deps.log?.(`[conductor] event observer failed for '${eventId}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const workflows = await this.deps.workflowStore.list();
    const started: Array<{ workflowSlug: string; runId: string }> = [];
    const skipped: EmitResult['skippedWorkflows'] = [];
    const suppressed: EmitResult['suppressed'] = [];
    const suppress = (workflowSlug: string, reason: EmitResult['suppressed'][number]['reason']): void => {
      suppressed.push({ workflowSlug, reason });
      this.deps.log?.(`[conductor] event '${eventId}' suppressed '${workflowSlug}': ${reason}`);
    };
    let matched = 0;
    const addressedAgent = this.resolveAddressedAgent(eventId, payload);

    for (const wf of workflows) {
      if (!wf.activeVersionId) continue;
      const version = await this.deps.workflowStore.getVersion(wf.activeVersionId);
      if (!version) continue;

      const triggers = version.graph.triggers ?? [];
      const match = triggers.find(
        (tr) =>
          (tr.kind === 'event' || tr.kind === 'webhook') &&
          tr.eventId === eventId &&
          this.filterMatches(tr.filter, payload),
      );
      if (!match) continue;
      if (wf.status !== 'enabled') {
        suppress(wf.slug, 'workflow_disabled');
        continue;
      }
      matched += 1;

      if (addressedAgent !== undefined) {
        const stepAgents = foreignAgentSteps(version.graph, addressedAgent);
        if (stepAgents.length > 0) {
          skipped.push({ workflowSlug: wf.slug, addressedAgent, stepAgents });
          this.deps.log?.(
            `[conductor] event '${eventId}' did not start '${wf.slug}': the message was addressed to ` +
              `Agent '${addressedAgent}', but the workflow's agent steps run as ${stepAgents
                .map((a) => `'${a}'`)
                .join(', ')}`,
          );
          continue;
        }
      }

      try {
        const run = await this.deps.executor.startRun({
          slug: wf.slug,
          payload,
          triggerKind: match.kind,
          triggerSource: { eventId, ...(sourcePluginId ? { sourcePluginId } : {}) },
        });
        started.push({ workflowSlug: wf.slug, runId: run.id });
        this.deps.log?.(`[conductor] event '${eventId}' started run ${run.id} on '${wf.slug}'`);
      } catch (err) {
        if (err instanceof WorkflowDisabledError || err instanceof WorkflowNotFoundError) {
          suppress(wf.slug, err instanceof WorkflowDisabledError ? 'workflow_disabled' : 'workflow_not_found');
        } else {
          this.deps.log?.(`[conductor] event '${eventId}' failed to start '${wf.slug}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { eventId, startedRuns: started, matchedWorkflows: matched, skippedWorkflows: skipped, suppressed };
  }

  private resolveAddressedAgent(eventId: string, payload: JsonObject): string | undefined {
    if (!this.deps.addressedAgent) return undefined;
    try {
      return this.deps.addressedAgent(eventId, payload);
    } catch (err) {
      this.deps.log?.(
        `[conductor] addressed-agent lookup failed for '${eventId}' (runs start; the step rule still applies): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** An absent filter always matches; otherwise the predicate is evaluated against the payload. */
  private filterMatches(filter: Predicate | undefined, payload: JsonObject): boolean {
    if (!filter) return true;
    return evaluatePredicate(filter, { ctx: payload, stepResult: payload });
  }
}
