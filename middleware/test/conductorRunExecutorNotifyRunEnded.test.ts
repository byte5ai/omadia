import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorRunExecutor } from '../src/conductor/runExecutor.js';
import type { ConductorRun, RunStatus } from '../src/conductor/runStore.js';

// Issue #437 review finding: ConductorRunExecutor's finalizeIfEnded/notifyRunEnded
// hook (the seam that feeds the outbound webhook dispatcher on run.completed /
// run.failed) was untested. Asserts it fires exactly on a genuinely terminal,
// non-dry-run status reached via TWO distinct paths — resolveAwait (completion) and
// expireAwait's no-fallback branch (failure) — and that a dry run never fires it.

/** Minimal single-human-step graph with no outgoing transition: resolving/expiring
 *  its await terminates the run directly (mirrors conductorQuorumAndTimeout.test.ts's
 *  harness shape), so finalizeIfEnded is reached without needing driveFrom. */
const graph = {
  entryStepId: 'h1',
  steps: [{ id: 'h1', kind: 'human', human: { principal: { kind: 'user', ref: 'alice' }, channel: 'teams', message: 'ok?' } }],
  transitions: [],
};

interface Harness {
  executor: ConductorRunExecutor;
  notified: ConductorRun[];
}

function makeHarness(opts: { isDryRun: boolean; fallbackTransitionId?: string | null }): Harness {
  const notified: ConductorRun[] = [];
  let run: ConductorRun & { status: RunStatus } = {
    id: 'run1',
    workflowVersionId: 'v1',
    status: 'waiting',
    currentStepId: 'h1',
    context: {},
    triggerKind: 'manual',
    triggerSource: null,
    isDryRun: opts.isDryRun,
    startedAt: new Date(0),
    endedAt: null,
  };
  const awaitRow = {
    id: 'aw1', runId: 'run1', stepId: 'h1', principalKind: 'user', principalRef: 'alice',
    channelType: 'teams', message: 'ok?', quorum: 'any', reminderIntervalMs: null, deadlineAt: null,
    fallbackTransitionId: opts.fallbackTransitionId ?? null, status: 'waiting', createdAt: new Date(0),
  };
  const awaitStore = {
    async get() { return awaitRow.status === 'waiting' ? awaitRow : null; },
    async recordResponse() {},
    async listResponses() { return []; },
    async close(_id: string, status: string) {
      if (awaitRow.status !== 'waiting') return false;
      awaitRow.status = status;
      return true;
    },
  };
  const runStore = {
    async get() { return { ...run }; },
    async acquireLease() {},
    async stepsForRun() { return []; },
    async recordStepAndAdvance(input: { status: RunStatus }) {
      run = { ...run, status: input.status, endedAt: input.status === 'completed' || input.status === 'failed' ? new Date(1) : run.endedAt };
    },
  };
  const workflowStore = {
    async getVersion() { return { id: 'v1', workflowId: 'w1', version: 1, graph }; },
  };
  const executor = new ConductorRunExecutor({
    workflowStore: workflowStore as never,
    runStore: runStore as never,
    awaitStore: awaitStore as never,
    effects: {} as never,
    resolveRoleHolders: async () => ({ holders: [], partial: false, bySource: [] }),
    notifyRunEnded: (endedRun) => notified.push(endedRun),
  });
  return { executor, notified };
}

describe('ConductorRunExecutor — notifyRunEnded (issue #437)', () => {
  it('fires with the completed run when resolveAwait drives the run to completion', async () => {
    const { executor, notified } = makeHarness({ isDryRun: false });
    await executor.resolveAwait('aw1', 'alice', { approved: true });

    assert.equal(notified.length, 1);
    assert.equal(notified[0]!.id, 'run1');
    assert.equal(notified[0]!.status, 'completed');
  });

  it('fires with the failed run when expireAwait times out with no fallback transition', async () => {
    const { executor, notified } = makeHarness({ isDryRun: false, fallbackTransitionId: null });
    await executor.expireAwait('aw1');

    assert.equal(notified.length, 1);
    assert.equal(notified[0]!.status, 'failed');
  });

  it('never fires for a dry run, even though it reaches the same terminal status', async () => {
    const { executor, notified } = makeHarness({ isDryRun: true });
    await executor.resolveAwait('aw1', 'alice', { approved: true });

    assert.equal(notified.length, 0, 'a dry run has no external effects to report — notifyRunEnded must stay silent');
  });

  it('a notifyRunEnded that throws is caught and logged, never propagated to the caller', async () => {
    const logs: string[] = [];
    let run: ConductorRun & { status: RunStatus } = {
      id: 'run1', workflowVersionId: 'v1', status: 'waiting', currentStepId: 'h1', context: {},
      triggerKind: 'manual', triggerSource: null, isDryRun: false, startedAt: new Date(0), endedAt: null,
    };
    const awaitRow = {
      id: 'aw1', runId: 'run1', stepId: 'h1', principalKind: 'user', principalRef: 'alice',
      channelType: 'teams', message: 'ok?', quorum: 'any', reminderIntervalMs: null, deadlineAt: null,
      fallbackTransitionId: null, status: 'waiting', createdAt: new Date(0),
    };
    const awaitStore = {
      async get() { return awaitRow.status === 'waiting' ? awaitRow : null; },
      async recordResponse() {},
      async listResponses() { return []; },
      async close(_id: string, status: string) {
        if (awaitRow.status !== 'waiting') return false;
        awaitRow.status = status;
        return true;
      },
    };
    const runStore = {
      async get() { return { ...run }; },
      async acquireLease() {},
      async stepsForRun() { return []; },
      async recordStepAndAdvance(input: { status: RunStatus }) {
        run = { ...run, status: input.status };
      },
    };
    const workflowStore = { async getVersion() { return { id: 'v1', workflowId: 'w1', version: 1, graph }; } };
    const executor = new ConductorRunExecutor({
      workflowStore: workflowStore as never,
      runStore: runStore as never,
      awaitStore: awaitStore as never,
      effects: {} as never,
      resolveRoleHolders: async () => ({ holders: [], partial: false, bySource: [] }),
      notifyRunEnded: () => {
        throw new Error('dispatcher blew up');
      },
      log: (msg) => logs.push(msg),
    });

    const result = await executor.resolveAwait('aw1', 'alice', { approved: true });

    assert.equal(result.status, 'completed', 'a broken subscriber must not affect run driving');
    assert.ok(logs.some((l) => l.includes('notifyRunEnded threw')), JSON.stringify(logs));
  });
});
