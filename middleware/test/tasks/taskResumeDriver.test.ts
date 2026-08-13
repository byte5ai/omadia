import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  InMemoryTaskStore,
  defineLongRunningTool,
  runTaskResumeOnce,
  startTaskResumeDriver,
  type ResumableTaskSource,
} from '@omadia/orchestrator';

/**
 * Issue #560, criterion 3 — the resume driver. It loops each source's
 * `resumeOne()` until nothing is claimable, at boot and on an interval. These
 * pin the draining, the per-source cap, and the boot sweep; the end-to-end
 * re-drive of a real long-running tool's task lives in `longRunningTool.test.ts`.
 */

/** A source that reports `count` claimable tasks, then nothing. */
function countingSource(count: number): { source: ResumableTaskSource; calls: () => number } {
  let remaining = count;
  let calls = 0;
  return {
    source: {
      resumeOne: async () => {
        calls += 1;
        if (remaining > 0) {
          remaining -= 1;
          return true;
        }
        return false;
      },
    },
    calls: () => calls,
  };
}

describe('tasks/taskResumeDriver — runTaskResumeOnce', () => {
  it('drains every source until nothing is claimable', async () => {
    const a = countingSource(3);
    const b = countingSource(1);
    const resumed = await runTaskResumeOnce([a.source, b.source]);
    assert.equal(resumed, 4, 'every claimable task across sources is driven');
    // One extra call per source is the "nothing left" probe that ends the loop.
    assert.equal(a.calls(), 4);
    assert.equal(b.calls(), 2);
  });

  it('caps the number driven per source per sweep', async () => {
    const busy = countingSource(1000);
    const resumed = await runTaskResumeOnce([busy.source], { maxPerSweep: 5 });
    assert.equal(resumed, 5, 'the cap bounds a single sweep');
    assert.equal(busy.calls(), 5, 'and it stops calling once the cap is hit');
  });

  it('a source that has nothing is a no-op', async () => {
    const empty = countingSource(0);
    assert.equal(await runTaskResumeOnce([empty.source]), 0);
  });
});

describe('tasks/taskResumeDriver — startTaskResumeDriver', () => {
  it('fires a boot sweep immediately and stops after dispose', async () => {
    const src = countingSource(2);
    let swept = -1;
    await new Promise<void>((resolveSweep) => {
      const dispose = startTaskResumeDriver([src.source], {
        intervalMs: 60_000, // long — only the boot sweep should run in this test
        onSweep: (resumed) => {
          swept = resumed;
          dispose();
          resolveSweep();
        },
      });
    });
    assert.equal(swept, 2, 'the boot sweep drove the claimable tasks');
  });

  it('drives a real long-running tool: a persisted-but-unclaimed task completes', async () => {
    // End-to-end shape of the boot recovery: a task exists in the store with no
    // runner attached (the create/claim crash gap), and the resume driver — given
    // the tool handle as a source — claims and completes it.
    const store = new InMemoryTaskStore();
    const handle = defineLongRunningTool({
      toolName: 'resumable_thing',
      longRunning: true,
      kind: 'resumable',
      cardLabel: 'Resumable',
      startDescription: 'x',
      inputProperties: { question: { type: 'string' } },
      store,
      execute: async (input) => `done: ${(input as { question: string }).question}`,
      onRunnerError: () => undefined,
    });
    const orphan = await store.create({ kind: 'resumable', input: { question: 'q' } });

    const resumed = await runTaskResumeOnce([handle]);
    assert.equal(resumed, 1);
    const row = await store.get(orphan.id);
    assert.equal(row?.status, 'completed');
    assert.equal(row?.result, 'done: q');
  });
});
