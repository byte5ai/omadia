import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorFacilitationAdmin } from '../src/conductor/facilitationAdmin.js';
import type { ConductorEphemeralAttachmentsStore } from '../src/conductor/ephemeralAttachmentsStore.js';
import type { ConductorRunStore } from '../src/conductor/runStore.js';
import type { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';

// #330 round 4 — the operator lens over live facilitations. All fakes: the
// module's contract is assembly (durable run context → overview) + the
// terminate order (cancel actives, then dispose through the reaper path).

const WF = {
  id: 'wf-1',
  slug: 'eph-facilitation-ab12cd34',
  name: 'Facilitation',
  description: null,
  status: 'enabled' as const,
  activeVersionId: 'ver-1',
  origin: 'ephemeral' as const,
  expiresAt: new Date('2026-08-25T07:00:00.000Z'),
  createdByAgent: '@omadia/agent-facilitator',
  reapedAt: null,
};

const RUN = {
  id: 'run-1',
  workflowVersionId: 'ver-1',
  status: 'waiting' as const,
  currentStepId: 'wait',
  context: {
    goal: 'omadia Event planen',
    definitionOfDone: '6 Punkte, alle bestätigt',
    stepAttempts: { moderate: 7 },
    stepResult: { data: { dodMet: false, summary: '3/6 Punkte offen' } },
  },
  triggerKind: 'agent',
  triggerSource: {},
  isDryRun: false,
  startedAt: new Date('2026-08-24T07:00:00.000Z'),
  endedAt: null,
  cancelRequestedBy: null,
  cancelRequestedAt: null,
};

function harness(opts?: { runStatus?: 'waiting' | 'running' | 'completed'; origin?: 'manual' | 'ephemeral'; cancelThrows?: boolean }) {
  const cancelled: string[] = [];
  const disposed: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const admin = new ConductorFacilitationAdmin({
    workflowStore: {
      listEphemeralActive: async () => [WF],
      getById: async (id: string) => (id === 'wf-1' ? { ...WF, origin: opts?.origin ?? 'ephemeral' } : null),
    } as unknown as ConductorWorkflowStore,
    runStore: {
      listForVersion: async () => [{ ...RUN, status: opts?.runStatus ?? 'waiting' }],
    } as unknown as ConductorRunStore,
    ephemeralAttachments: {
      getByWorkflow: async () => [
        {
          id: '1',
          workflowId: 'wf-1',
          agentSlug: 'facilitator',
          channelType: 'teams',
          channelKey: 'conv-1',
          roleKey: 'facilitation-abc',
          state: 'attached',
          expiresAt: new Date('2026-08-25T07:00:00.000Z'),
        },
      ],
    } as unknown as ConductorEphemeralAttachmentsStore,
    executor: {
      cancelRun: async (runId: string) => {
        if (opts?.cancelThrows) throw new Error('driver busy');
        cancelled.push(runId);
        return { ...RUN, status: 'cancelled' } as never;
      },
    },
    auditTerminate: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    disposeWorkflow: async (workflowId: string) => {
      disposed.push(workflowId);
    },
    resolveRoleHolders: async (key) => (key === 'facilitation-abc' ? ['mwege@byte5.de'] : []),
    getRoster: async () => ({
      participants: [
        { userRef: { id: 'aad-1', displayName: 'Marcel Wege' }, isBot: false },
        { userRef: { id: '28:bot' }, isBot: true },
      ],
      partial: false,
    }),
  });
  return { admin, cancelled, disposed, audits };
}

describe('ConductorFacilitationAdmin.list', () => {
  it('assembles conversation, durable goal/DoD, rounds, verdict, initiators and roster', async () => {
    const { admin } = harness();
    const rows = await admin.list();
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual(row.conversation, { channelType: 'teams', conversationId: 'conv-1' });
    assert.equal(row.run?.goal, 'omadia Event planen');
    assert.equal(row.run?.definitionOfDone, '6 Punkte, alle bestätigt');
    assert.equal(row.run?.rounds, 7);
    assert.deepEqual(row.run?.lastVerdict, { dodMet: false, summary: '3/6 Punkte offen' });
    assert.deepEqual(row.initiators, ['mwege@byte5.de']);
    assert.deepEqual(
      row.participants?.map((p) => p.displayName),
      ['Marcel Wege', '28:bot'],
    );
    assert.equal(row.participantsPartial, false);
    assert.equal(row.incomplete, false);
    assert.equal(row.expiresAt, '2026-08-25T07:00:00.000Z');
  });
});

describe('ConductorFacilitationAdmin.terminate', () => {
  it('cancels active runs, then disposes through the reaper path — with an audit trace', async () => {
    const { admin, cancelled, disposed, audits } = harness({ runStatus: 'waiting' });
    const out = await admin.terminate('wf-1', 'mwege@byte5.de', 'uuid-1');
    assert.deepEqual(out, { outcome: 'terminated', cancelledRuns: 1 });
    assert.deepEqual(cancelled, ['run-1']);
    assert.deepEqual(disposed, ['wf-1']);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actor, 'mwege@byte5.de');
    assert.equal(audits[0]!.actorUserId, 'uuid-1');
  });

  it('skips terminal runs but still disposes the scaffold (zombie cleanup)', async () => {
    const { admin, cancelled, disposed } = harness({ runStatus: 'completed' });
    const out = await admin.terminate('wf-1', 'op');
    assert.deepEqual(out, { outcome: 'terminated', cancelledRuns: 0 });
    assert.deepEqual(cancelled, []);
    assert.deepEqual(disposed, ['wf-1']);
  });

  it('a failed cancel SKIPS disposal — a live run must never vanish from the lens (review H1)', async () => {
    const { admin, disposed, audits } = harness({ runStatus: 'running', cancelThrows: true });
    const out = await admin.terminate('wf-1', 'op');
    assert.deepEqual(out, { outcome: 'cancel_failed', cancelledRuns: 0, failedRuns: 1 });
    assert.deepEqual(disposed, []);
    assert.deepEqual(audits, []);
  });

  it('refuses non-ephemeral workflows — the library is out of reach', async () => {
    const { admin, disposed } = harness({ origin: 'manual' });
    const out = await admin.terminate('wf-1', 'op');
    assert.deepEqual(out, { outcome: 'not_found' });
    assert.deepEqual(disposed, []);
  });
});
