import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { JsonObject, WorkflowGraph } from '@omadia/conductor-core';

import { ConductorEventRouter } from '../src/conductor/eventRouter.js';
import type { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import type { ConductorRunExecutor } from '../src/conductor/runExecutor.js';

// Issue #437 — the inbound webhook route emits its endpoint's configured eventId
// through the SAME ConductorEventRouter US4 already uses; a workflow can subscribe
// with either an `event` trigger (unchanged) or the newly-implemented `webhook`
// trigger kind. Both must match identically — `webhook` is `event`'s sibling, not a
// separate mechanism (see eventRouter.ts's updated doc comment).

interface FakeWorkflow {
  slug: string;
  status: 'enabled' | 'disabled';
  activeVersionId: string | null;
}

function fakeWorkflowStore(workflows: FakeWorkflow[], graphs: Record<string, WorkflowGraph>): ConductorWorkflowStore {
  return {
    list: async () => workflows as unknown as Awaited<ReturnType<ConductorWorkflowStore['list']>>,
    getVersion: async (versionId: string) =>
      ({ id: versionId, workflowId: 'wf-id', version: 1, graph: graphs[versionId] }) as unknown as Awaited<
        ReturnType<ConductorWorkflowStore['getVersion']>
      >,
  } as unknown as ConductorWorkflowStore;
}

function fakeExecutor(started: Array<{ slug: string; triggerKind: string }>): ConductorRunExecutor {
  return {
    startRun: async (input: { slug: string; triggerKind?: string }) => {
      started.push({ slug: input.slug, triggerKind: input.triggerKind ?? 'manual' });
      return { id: `run-${String(started.length)}` } as unknown as Awaited<ReturnType<ConductorRunExecutor['startRun']>>;
    },
  } as unknown as ConductorRunExecutor;
}

function graphWithTrigger(kind: 'event' | 'webhook', eventId: string): WorkflowGraph {
  return {
    entryStepId: 'start',
    steps: [{ id: 'start', kind: 'action', actionId: 'noop' }],
    transitions: [],
    triggers: [{ id: 't1', kind, eventId }],
  };
}

describe('ConductorEventRouter — webhook trigger kind (issue #437)', () => {
  it('starts a run for a workflow with a webhook trigger matching the emitted eventId', async () => {
    const started: Array<{ slug: string; triggerKind: string }> = [];
    const workflowStore = fakeWorkflowStore(
      [{ slug: 'wf-webhook', status: 'enabled', activeVersionId: 'v1' }],
      { v1: graphWithTrigger('webhook', 'orders.created') },
    );
    const router = new ConductorEventRouter({ workflowStore, executor: fakeExecutor(started) });

    const result = await router.emit('orders.created', { orderId: 42 } as JsonObject, 'webhook:ep-1');

    assert.equal(result.matchedWorkflows, 1);
    assert.equal(result.startedRuns.length, 1);
    assert.equal(result.startedRuns[0]?.workflowSlug, 'wf-webhook');
    assert.deepEqual(started, [{ slug: 'wf-webhook', triggerKind: 'webhook' }]);
  });

  it('still matches the existing event trigger kind (no regression)', async () => {
    const started: Array<{ slug: string; triggerKind: string }> = [];
    const workflowStore = fakeWorkflowStore(
      [{ slug: 'wf-event', status: 'enabled', activeVersionId: 'v1' }],
      { v1: graphWithTrigger('event', 'orders.created') },
    );
    const router = new ConductorEventRouter({ workflowStore, executor: fakeExecutor(started) });

    const result = await router.emit('orders.created', {}, undefined);

    assert.equal(result.matchedWorkflows, 1);
    assert.deepEqual(started, [{ slug: 'wf-event', triggerKind: 'event' }]);
  });

  it('does not match a webhook trigger with a different eventId, or a disabled workflow', async () => {
    const started: Array<{ slug: string; triggerKind: string }> = [];
    const workflowStore = fakeWorkflowStore(
      [
        { slug: 'wf-other-event', status: 'enabled', activeVersionId: 'v1' },
        { slug: 'wf-disabled', status: 'disabled', activeVersionId: 'v2' },
      ],
      { v1: graphWithTrigger('webhook', 'a.different.event'), v2: graphWithTrigger('webhook', 'orders.created') },
    );
    const router = new ConductorEventRouter({ workflowStore, executor: fakeExecutor(started) });

    const result = await router.emit('orders.created', {}, undefined);

    assert.equal(result.matchedWorkflows, 0);
    assert.deepEqual(started, []);
  });
});
