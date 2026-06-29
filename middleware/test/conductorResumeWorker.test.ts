import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorRunResumeWorker } from '../src/conductor/runResumeWorker.js';
import type { ConductorRunStore } from '../src/conductor/runStore.js';
import type { ConductorRunExecutor } from '../src/conductor/runExecutor.js';

// Conductor US2 / SC-002 — the resume worker re-drives runs orphaned by a process restart.
// These tests exercise the tick logic with fakes (no Postgres): the at-most-once / staleness
// guarantees themselves live in the SQL claim, verified separately against a live DB.

function fakeRun(id: string, currentStepId: string | null = 's1'): Record<string, unknown> {
  return {
    id,
    workflowVersionId: 'v1',
    status: 'running',
    currentStepId,
    context: {},
    triggerKind: 'manual',
    triggerSource: null,
    isDryRun: false,
    startedAt: new Date(0),
    endedAt: null,
  };
}

describe('ConductorRunResumeWorker.tick', () => {
  it('resumes every claimed run once, threading the claim lease through to resumeRun', async () => {
    const resumed: Array<{ runId: string; lease: string }> = [];
    let claimArgs: { lease: string; staleMs: number; limit: number } | null = null;
    const runStore = {
      async claimResumableRuns(lease: string, staleMs: number, limit: number) {
        claimArgs = { lease, staleMs, limit };
        return [fakeRun('a'), fakeRun('b')];
      },
    } as unknown as ConductorRunStore;
    const executor = {
      async resumeRun(runId: string, lease: string) {
        resumed.push({ runId, lease });
        return fakeRun(runId);
      },
    } as unknown as ConductorRunExecutor;

    const worker = new ConductorRunResumeWorker({ runStore, executor, claimerId: 'boot-1' });
    await worker.tick();
    // resumeRun is fire-and-forget inside the tick — let the microtasks flush.
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(resumed.map((r) => r.runId).sort(), ['a', 'b']);
    assert.equal(claimArgs!.staleMs, 900_000); // default 15 min ≫ orchestrator wall-clock cap
    // The fencing lease the worker claimed with must be the same token it drives each run under.
    assert.ok(claimArgs!.lease.length > 0);
    assert.ok(resumed.every((r) => r.lease === claimArgs!.lease));
  });

  it('does nothing when no runs are claimable', async () => {
    const resumed: string[] = [];
    const runStore = { async claimResumableRuns() { return []; } } as unknown as ConductorRunStore;
    const executor = {
      async resumeRun(runId: string) { resumed.push(runId); return fakeRun(runId); },
    } as unknown as ConductorRunExecutor;

    const worker = new ConductorRunResumeWorker({ runStore, executor, claimerId: 'boot-1' });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(resumed, []);
  });

  it('swallows a claim error rather than throwing out of the tick', async () => {
    const runStore = {
      async claimResumableRuns() { throw new Error('db down'); },
    } as unknown as ConductorRunStore;
    const executor = { async resumeRun() { return fakeRun('x'); } } as unknown as ConductorRunExecutor;

    const worker = new ConductorRunResumeWorker({ runStore, executor, claimerId: 'boot-1' });
    await assert.doesNotReject(() => worker.tick());
  });

  it('never overlaps ticks (the in-flight guard)', async () => {
    let claimCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runStore = {
      async claimResumableRuns() {
        claimCalls += 1;
        await gate; // hold the first tick open
        return [];
      },
    } as unknown as ConductorRunStore;
    const executor = { async resumeRun() { return fakeRun('x'); } } as unknown as ConductorRunExecutor;

    const worker = new ConductorRunResumeWorker({ runStore, executor, claimerId: 'boot-1' });
    const first = worker.tick();
    await worker.tick(); // should early-return while the first is still claiming
    assert.equal(claimCalls, 1);
    release();
    await first;
  });
});
