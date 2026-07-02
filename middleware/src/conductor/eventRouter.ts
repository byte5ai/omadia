import { evaluatePredicate } from '@omadia/conductor-core';
import type { JsonObject, Predicate } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRunExecutor } from './runExecutor.js';

export interface EmitResult {
  eventId: string;
  startedRuns: Array<{ workflowSlug: string; runId: string }>;
  matchedWorkflows: number;
}

/**
 * Routes a domain event to the workflows that subscribe to it. A workflow subscribes via an
 * `event` trigger in its active version graph (an `eventId` plus an optional payload `filter`
 * predicate). A matching emit starts a run with the validated payload as initial context (US4 /
 * FR-013). This is the kernel side of the Conductor Surface; a connector calls it (today via the
 * operator emit route; `ctx.events.emit` for plugins is a follow-up).
 */
export class ConductorEventRouter {
  constructor(
    private readonly deps: {
      workflowStore: ConductorWorkflowStore;
      executor: ConductorRunExecutor;
      log?: (msg: string) => void;
    },
  ) {}

  async emit(eventId: string, payload: JsonObject, sourcePluginId?: string): Promise<EmitResult> {
    const workflows = await this.deps.workflowStore.list();
    const started: Array<{ workflowSlug: string; runId: string }> = [];
    let matched = 0;

    for (const wf of workflows) {
      if (wf.status !== 'enabled' || !wf.activeVersionId) continue;
      const version = await this.deps.workflowStore.getVersion(wf.activeVersionId);
      if (!version) continue;

      const triggers = version.graph.triggers ?? [];
      const match = triggers.find(
        (tr) => tr.kind === 'event' && tr.eventId === eventId && this.filterMatches(tr.filter, payload),
      );
      if (!match) continue;
      matched += 1;

      try {
        const run = await this.deps.executor.startRun({
          slug: wf.slug,
          payload,
          triggerKind: 'event',
          triggerSource: { eventId, ...(sourcePluginId ? { sourcePluginId } : {}) },
        });
        started.push({ workflowSlug: wf.slug, runId: run.id });
        this.deps.log?.(`[conductor] event '${eventId}' started run ${run.id} on '${wf.slug}'`);
      } catch (err) {
        this.deps.log?.(`[conductor] event '${eventId}' failed to start '${wf.slug}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { eventId, startedRuns: started, matchedWorkflows: matched };
  }

  /** An absent filter always matches; otherwise the predicate is evaluated against the payload. */
  private filterMatches(filter: Predicate | undefined, payload: JsonObject): boolean {
    if (!filter) return true;
    return evaluatePredicate(filter, { ctx: payload, stepResult: payload });
  }
}
