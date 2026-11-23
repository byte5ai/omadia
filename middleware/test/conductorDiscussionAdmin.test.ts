import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorDiscussionAdmin, type DiscussionAdminDeps } from '../src/conductor/discussionAdmin.js';

// #2067 — the operator's view of runs agents started themselves. All fakes: the
// contract is the assembly (what the run recorded → one row) and the stop order
// (cancel the active runs, then dispose through the reaper's path).

const WF = {
  id: 'wf-1',
  slug: 'eph-discussion-ab12cd34',
  name: 'Discussion',
  description: null,
  status: 'enabled' as const,
  activeVersionId: 'ver-1',
  origin: 'ephemeral' as const,
  expiresAt: new Date('2026-11-20T07:00:00.000Z'),
  createdByAgent: 'hr',
  reapedAt: null,
};

const RUN = {
  id: 'run-1',
  workflowVersionId: 'ver-1',
  status: 'running' as const,
  currentStepId: 'say',
  context: {
    topic: '  Budget 2027 ',
    guidingQuestion: 'What do we cut?',
    conversationId: 'conv-from-run',
    channelType: 'teams',
    participants: ['hr', 'accounting', 7, ''],
    speaker: 'accounting',
  },
  triggerKind: 'agent',
  triggerSource: {},
  isDryRun: false,
  startedAt: new Date('2026-11-19T07:00:00.000Z'),
  endedAt: null,
  cancelRequestedBy: null,
  cancelRequestedAt: null,
  errorCode: null,
  errorMessage: null,
};

const ATTACHMENT = { id: '1', workflowId: 'wf-1', agentSlug: 'hr', channelType: 'teams', channelKey: 'conv-1', roleKey: null };

interface Options {
  runs?: unknown[];
  runListingFails?: boolean;
  attachments?: unknown[];
  attachmentLookupFails?: boolean;
  origin?: 'manual' | 'ephemeral';
  cancelFailsFor?: string[];
}

function harness(opts: Options = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps = {
    workflowStore: {
      listEphemeralActive: () => Promise.resolve([WF]),
      getById: (id: string) => Promise.resolve(id === 'wf-1' ? { ...WF, origin: opts.origin ?? 'ephemeral' } : null),
    },
    runStore: {
      listForVersion: () => (opts.runListingFails ? Promise.reject(new Error('db down')) : Promise.resolve(opts.runs ?? [RUN])),
    },
    ephemeralAttachments: {
      getByWorkflow: () =>
        opts.attachmentLookupFails ? Promise.reject(new Error('db down')) : Promise.resolve(opts.attachments ?? [ATTACHMENT]),
    },
    executor: {
      cancelRun: (runId: string, actor: string) => {
        calls.push(`cancel(${runId}, ${actor})`);
        return opts.cancelFailsFor?.includes(runId) ? Promise.reject(new Error('busy')) : Promise.resolve();
      },
    },
    disposeWorkflow: (workflowId: string) => {
      calls.push(`dispose(${workflowId})`);
      return Promise.resolve();
    },
    log: (msg: string) => {
      logs.push(msg);
    },
  } as unknown as DiscussionAdminDeps;
  return { admin: new ConductorDiscussionAdmin(deps), calls, logs };
}

describe('#2067 running agent discussions: list', () => {
  it('shows who opened it, who takes part, the topic and the conversation', async () => {
    const { admin } = harness();
    assert.deepEqual(await admin.list(), [
      {
        workflowId: 'wf-1',
        slug: 'eph-discussion-ab12cd34',
        openedBy: 'hr',
        participants: ['hr', 'accounting'],
        topic: 'Budget 2027',
        conversation: { channelType: 'teams', conversationId: 'conv-1' },
        status: 'running',
        startedAt: '2026-11-19T07:00:00.000Z',
        stopRequestedAt: null,
        expiresAt: '2026-11-20T07:00:00.000Z',
        incomplete: false,
      },
    ]);
  });

  it('falls back to the conversation the run recorded when no binding is attached', async () => {
    const { admin } = harness({ attachments: [] });
    assert.deepEqual((await admin.list())[0]?.conversation, { channelType: 'teams', conversationId: 'conv-from-run' });
  });

  it('lists a run that is not a discussion without inventing a topic or a cast', async () => {
    const { admin } = harness({ runs: [{ ...RUN, context: { goal: 'something else' } }], attachments: [] });
    const row = (await admin.list())[0];
    assert.equal(row?.topic, null);
    assert.deepEqual(row?.participants, []);
    assert.equal(row?.conversation, null);
    assert.equal(row?.incomplete, false);
  });

  it('shows a requested stop that has not taken effect yet', async () => {
    const { admin } = harness({ runs: [{ ...RUN, cancelRequestedAt: new Date('2026-11-19T08:00:00.000Z') }] });
    assert.equal((await admin.list())[0]?.stopRequestedAt, '2026-11-19T08:00:00.000Z');
  });

  it('keeps the row and marks it incomplete when a lookup fails', async () => {
    const { admin, logs } = harness({ runListingFails: true, attachmentLookupFails: true });
    const row = (await admin.list())[0];
    assert.equal(row?.workflowId, 'wf-1');
    assert.equal(row?.incomplete, true);
    assert.equal(row?.status, null);
    assert.equal(row?.conversation, null);
    assert.equal(logs.length, 2);
  });
});

describe('#2067 running agent discussions: stop', () => {
  it('cancels the active runs, then disposes of the workflow', async () => {
    const { admin, calls } = harness({
      runs: [RUN, { ...RUN, id: 'run-2', status: 'waiting' }, { ...RUN, id: 'run-3', status: 'completed' }],
    });
    assert.deepEqual(await admin.stop('wf-1', 'op@example.test'), {
      outcome: 'stopped',
      slug: 'eph-discussion-ab12cd34',
      cancelledRuns: 2,
    });
    assert.deepEqual(calls, ['cancel(run-1, op@example.test)', 'cancel(run-2, op@example.test)', 'dispose(wf-1)']);
  });

  it('disposes of a workflow whose runs have all ended', async () => {
    const { admin, calls } = harness({ runs: [{ ...RUN, status: 'completed' }] });
    assert.deepEqual(await admin.stop('wf-1', 'op'), { outcome: 'stopped', slug: WF.slug, cancelledRuns: 0 });
    assert.deepEqual(calls, ['dispose(wf-1)']);
  });

  it('disposes of nothing when a cancel fails, so the discussion stays listed', async () => {
    const { admin, calls } = harness({ runs: [RUN, { ...RUN, id: 'run-2' }], cancelFailsFor: ['run-2'] });
    assert.deepEqual(await admin.stop('wf-1', 'op'), { outcome: 'cancel_failed', cancelledRuns: 1, failedRuns: 1 });
    assert.ok(!calls.includes('dispose(wf-1)'));
  });

  it('disposes of nothing when the runs cannot be read', async () => {
    const { admin, calls } = harness({ runListingFails: true });
    assert.deepEqual(await admin.stop('wf-1', 'op'), { outcome: 'cancel_failed', cancelledRuns: 0, failedRuns: 1 });
    assert.deepEqual(calls, []);
  });

  it('refuses an unknown workflow and one an operator authored', async () => {
    assert.deepEqual(await harness().admin.stop('wf-9', 'op'), { outcome: 'not_found' });
    const manual = harness({ origin: 'manual' });
    assert.deepEqual(await manual.admin.stop('wf-1', 'op'), { outcome: 'not_found' });
    assert.deepEqual(manual.calls, []);
  });
});
