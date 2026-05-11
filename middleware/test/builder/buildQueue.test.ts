import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  BuildQueue,
  type BuildPhase,
  type QueueBuildFn,
} from '../../src/plugins/builder/buildQueue.js';
import type { BuildResult, BuildSuccess } from '../../src/plugins/builder/buildSandbox.js';

function okResult(durationMs = 1): BuildSuccess {
  return { ok: true, zip: Buffer.alloc(0), zipPath: '/x.zip', durationMs };
}

interface ControlledBuild {
  fn: QueueBuildFn;
  started(): boolean;
  signal(): AbortSignal | undefined;
  finish(result: BuildResult): void;
  finishOk(): void;
}

function controlledBuild(): ControlledBuild {
  let resolve!: (r: BuildResult) => void;
  let started = false;
  let signal: AbortSignal | undefined;
  const promise = new Promise<BuildResult>((r) => {
    resolve = r;
  });
  const fn: QueueBuildFn = (s) => {
    started = true;
    signal = s;
    return promise;
  };
  return {
    fn,
    started: () => started,
    signal: () => signal,
    finish: (r) => resolve(r),
    finishOk: () => resolve(okResult()),
  };
}

async function tick() {
  await new Promise((r) => setImmediate(r));
}

describe('BuildQueue', () => {
  describe('basic flow', () => {
    it('runs a single build and resolves with its result', async () => {
      const q = new BuildQueue({ concurrency: 1 });
      const b = controlledBuild();
      const p = q.enqueue('d1', b.fn);
      await tick();
      assert.equal(b.started(), true);
      b.finishOk();
      const result = await p;
      assert.equal(result.ok, true);
    });

    it('runs distinct draftIds in parallel up to concurrency', async () => {
      const q = new BuildQueue({ concurrency: 3 });
      const builds = [controlledBuild(), controlledBuild(), controlledBuild()];
      const ps = builds.map((b, i) => q.enqueue(`d${i}`, b.fn));
      await tick();
      for (const b of builds) assert.equal(b.started(), true);
      assert.equal(q.runningSize, 3);
      for (const b of builds) b.finishOk();
      await Promise.all(ps);
    });

    it('queues entries beyond the concurrency cap (FIFO)', async () => {
      const q = new BuildQueue({ concurrency: 2 });
      const b1 = controlledBuild();
      const b2 = controlledBuild();
      const b3 = controlledBuild();

      const p1 = q.enqueue('d1', b1.fn);
      const p2 = q.enqueue('d2', b2.fn);
      const p3 = q.enqueue('d3', b3.fn);
      await tick();
      assert.equal(q.runningSize, 2);
      assert.equal(q.queuedSize, 1);
      assert.equal(b3.started(), false);

      b1.finishOk();
      await p1;
      await tick();
      assert.equal(b3.started(), true);
      b2.finishOk();
      b3.finishOk();
      await Promise.all([p2, p3]);
    });
  });

  describe('coalescing', () => {
    it('aborts a queued entry when a fresh enqueue replaces it', async () => {
      const q = new BuildQueue({ concurrency: 1 });
      const blocker = controlledBuild();
      const old = controlledBuild();
      const replacement = controlledBuild();

      const pBlocker = q.enqueue('block', blocker.fn);
      const pOld = q.enqueue('d1', old.fn);
      await tick();
      assert.equal(old.started(), false); // queued behind blocker

      const pNew = q.enqueue('d1', replacement.fn);
      await tick();

      // old's promise should already have settled as 'abort'
      const oldResult = await pOld;
      assert.equal(oldResult.ok, false);
      if (!oldResult.ok) assert.equal(oldResult.reason, 'abort');
      assert.equal(old.started(), false);

      // Free the queue to let the replacement run.
      blocker.finishOk();
      await pBlocker;
      await tick();
      assert.equal(replacement.started(), true);
      replacement.finishOk();
      const newResult = await pNew;
      assert.equal(newResult.ok, true);
    });

    it('signals abort to a running entry when coalesced', async () => {
      const q = new BuildQueue({ concurrency: 1 });
      const oldRunning = controlledBuild();

      const pOld = q.enqueue('d1', oldRunning.fn);
      await tick();
      assert.equal(oldRunning.started(), true);
      const sig = oldRunning.signal()!;
      assert.equal(sig.aborted, false);

      const replacement = controlledBuild();
      const pNew = q.enqueue('d1', replacement.fn);

      await tick();
      assert.equal(sig.aborted, true);

      // The build function itself controls how it reacts. We simulate an
      // abort-aware build returning a BuildFailure with reason 'abort'.
      oldRunning.finish({
        ok: false,
        errors: [],
        exitCode: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        reason: 'abort',
      });
      const oldResult = await pOld;
      assert.equal(oldResult.ok, false);
      if (!oldResult.ok) assert.equal(oldResult.reason, 'abort');

      await tick();
      assert.equal(replacement.started(), true);
      replacement.finishOk();
      await pNew;
    });

    it('re-tags non-abort failures as abort when the signal was aborted', async () => {
      const q = new BuildQueue({ concurrency: 1 });
      const old = controlledBuild();
      const pOld = q.enqueue('d1', old.fn);
      await tick();

      q.enqueue('d1', controlledBuild().fn);
      await tick();

      // Even if the build function reports a different failure reason,
      // BuildQueue re-tags as 'abort' when the signal was aborted.
      old.finish({
        ok: false,
        errors: [],
        exitCode: 2,
        stdoutTail: '',
        stderrTail: 'something else',
        durationMs: 1,
        reason: 'unknown',
      });
      const r = await pOld;
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, 'abort');
    });
  });

  describe('state callbacks', () => {
    it('emits queued → building → ok in order', async () => {
      const events: Array<[string, BuildPhase, number?]> = [];
      const q = new BuildQueue({
        concurrency: 1,
        onStateChange: (draftId, phase, pos) => {
          events.push([draftId, phase, pos]);
        },
      });
      const b = controlledBuild();
      const p = q.enqueue('d1', b.fn);
      await tick();
      b.finishOk();
      await p;

      const phases = events.filter((e) => e[0] === 'd1').map((e) => e[1]);
      assert.deepEqual(phases, ['queued', 'building', 'ok']);
    });

    it('emits failed when the result is a non-abort failure', async () => {
      const events: Array<[string, BuildPhase]> = [];
      const q = new BuildQueue({
        concurrency: 1,
        onStateChange: (d, ph) => events.push([d, ph]),
      });
      const b = controlledBuild();
      const p = q.enqueue('d1', b.fn);
      await tick();
      b.finish({
        ok: false,
        errors: [],
        exitCode: 1,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        reason: 'tsc',
      });
      await p;
      assert.ok(events.some((e) => e[0] === 'd1' && e[1] === 'failed'));
    });

    it('does not let onStateChange exceptions break the queue', async () => {
      const q = new BuildQueue({
        concurrency: 1,
        onStateChange: () => {
          throw new Error('boom');
        },
      });
      const b = controlledBuild();
      const p = q.enqueue('d1', b.fn);
      await tick();
      b.finishOk();
      const r = await p;
      assert.equal(r.ok, true);
    });
  });

  describe('drain', () => {
    it('returns immediately when nothing is in flight', async () => {
      const q = new BuildQueue();
      const result = await q.drain(1000);
      assert.equal(result.drained, true);
      assert.equal(result.remainingRunning, 0);
    });

    it('aborts queued waiters when called', async () => {
      const q = new BuildQueue({ concurrency: 1 });
      const blocker = controlledBuild();
      const waiter = controlledBuild();
      const pBlock = q.enqueue('block', blocker.fn);
      const pWait = q.enqueue('w1', waiter.fn);
      await tick();
      assert.equal(waiter.started(), false);

      const drainP = q.drain(500);
      const r = await pWait;
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, 'abort');

      blocker.finishOk();
      await pBlock;
      const drainR = await drainP;
      assert.equal(drainR.drained, true);
    });

    it('rejects new enqueues after drain starts', async () => {
      const q = new BuildQueue();
      void q.drain(50);
      const r = await q.enqueue('d1', () => Promise.resolve(okResult()));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, 'abort');
    });

    it('force-aborts running builds after the timeout', async () => {
      const q = new BuildQueue({ concurrency: 1 });
      const stuck = controlledBuild();
      const pStuck = q.enqueue('d1', stuck.fn);
      await tick();
      assert.equal(stuck.started(), true);

      const drainResult = await q.drain(50);
      // The running build's signal should have been aborted by drain.
      assert.equal(stuck.signal()?.aborted, true);

      // We still need to settle stuck.fn to clean up the test (queue's
      // remainingRunning may be > 0 if fn never resolves).
      stuck.finish({
        ok: false,
        errors: [],
        exitCode: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
        reason: 'abort',
      });
      await pStuck;

      // drain reported its state. If stuck.fn didn't resolve in time, drained=false.
      assert.equal(typeof drainResult.drained, 'boolean');
    });
  });

  describe('introspection', () => {
    it('reports size, queuedSize, runningSize correctly', async () => {
      const q = new BuildQueue({ concurrency: 1 });
      assert.equal(q.size, 0);
      const b1 = controlledBuild();
      const b2 = controlledBuild();
      const p1 = q.enqueue('d1', b1.fn);
      const p2 = q.enqueue('d2', b2.fn);
      await tick();
      assert.equal(q.runningSize, 1);
      assert.equal(q.queuedSize, 1);
      assert.equal(q.size, 2);
      b1.finishOk();
      await p1;
      await tick();
      assert.equal(q.queuedSize, 0);
      assert.equal(q.runningSize, 1);
      b2.finishOk();
      await p2;
    });
  });
});
