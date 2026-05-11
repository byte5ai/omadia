import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  JobAlreadyRegisteredError,
  JobValidationError,
  type JobHandler,
  type JobSpec,
} from '@omadia/plugin-api';

import { JobScheduler, type TimerSeam } from '../src/plugins/jobScheduler.js';

/**
 * The scheduler is exercised through its public surface only — register,
 * stopForPlugin, list, and the dispose handle returned by register. To stay
 * deterministic for interval-driven jobs we hand the scheduler a mock timer
 * seam that exposes a `tick()` method; cron-driven behaviour is asserted
 * via validateSpec (cron parsing) rather than wall-clock waits, since
 * croner's smallest schedule is 1s and adding sleeps to unit tests is the
 * kind of flake we'd rather not bake in.
 */

interface MockTimers extends TimerSeam {
  /** Fire the most recently registered setInterval callback once. */
  tick(): void;
  /** Manually run any pending setTimeout — used to assert timeouts. */
  fireTimeout(): void;
  pendingIntervals(): number;
  pendingTimeouts(): number;
}

function makeMockTimers(): MockTimers {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let intervalSeq = 0;
  let timeoutSeq = 0;
  return {
    setInterval(cb) {
      const id = ++intervalSeq;
      intervals.set(id, cb);
      return id;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
    setTimeout(cb) {
      const id = ++timeoutSeq;
      timeouts.set(id, cb);
      return id;
    },
    clearTimeout(handle) {
      timeouts.delete(handle as number);
    },
    tick() {
      // Fire the highest-id interval (= the one most recently registered).
      // Tests register one job at a time so this is unambiguous.
      const id = Math.max(...intervals.keys());
      const cb = intervals.get(id);
      if (cb) cb();
    },
    fireTimeout() {
      const id = Math.max(...timeouts.keys());
      const cb = timeouts.get(id);
      if (cb) cb();
    },
    pendingIntervals: () => intervals.size,
    pendingTimeouts: () => timeouts.size,
  };
}

const ANY_AGENT = 'de.byte5.test.jobs';

const intervalSpec = (overrides: Partial<JobSpec> = {}): JobSpec => ({
  name: 'demo',
  schedule: { intervalMs: 1000 },
  ...overrides,
});

describe('JobScheduler — registration and lifecycle', () => {
  it('runs the handler when the interval trigger fires', async () => {
    const timers = makeMockTimers();
    const scheduler = new JobScheduler({ log: () => {}, timers });
    let runs = 0;
    scheduler.register(ANY_AGENT, intervalSpec(), async () => {
      runs += 1;
    });
    timers.tick();
    await flush();
    assert.equal(runs, 1);
  });

  it('passes an AbortSignal that is aborted on stopForPlugin', async () => {
    const timers = makeMockTimers();
    const scheduler = new JobScheduler({ log: () => {}, timers });
    let captured: AbortSignal | null = null;
    let pendingResolve: (() => void) | null = null;
    const handler: JobHandler = async (signal) => {
      captured = signal;
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    };
    scheduler.register(ANY_AGENT, intervalSpec(), handler);
    timers.tick();
    await flush();
    assert.ok(captured, 'handler should have received a signal');
    assert.equal(captured!.aborted, false);
    scheduler.stopForPlugin(ANY_AGENT);
    assert.equal(captured!.aborted, true, 'signal must abort on stopForPlugin');
    pendingResolve?.();
    await flush();
  });

  it('fires the AbortSignal when the per-run timeout elapses', async () => {
    const timers = makeMockTimers();
    const scheduler = new JobScheduler({ log: () => {}, timers });
    let captured: AbortSignal | null = null;
    let pendingResolve: (() => void) | null = null;
    scheduler.register(ANY_AGENT, intervalSpec({ timeoutMs: 50 }), async (signal) => {
      captured = signal;
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    });
    timers.tick();
    await flush();
    assert.equal(timers.pendingTimeouts(), 1, 'timeout setTimeout should be armed');
    timers.fireTimeout();
    assert.equal(captured!.aborted, true);
    pendingResolve?.();
    await flush();
  });

  it("overlap='skip' (default) drops a tick that arrives mid-run", async () => {
    const timers = makeMockTimers();
    const scheduler = new JobScheduler({ log: () => {}, timers });
    let runs = 0;
    let pendingResolve: (() => void) | null = null;
    scheduler.register(ANY_AGENT, intervalSpec(), async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    });
    timers.tick();
    await flush();
    assert.equal(runs, 1);
    timers.tick();
    timers.tick();
    await flush();
    assert.equal(runs, 1, 'overlap=skip must drop ticks while previous still running');
    pendingResolve?.();
    await flush();
    timers.tick();
    await flush();
    assert.equal(runs, 2, 'next tick after first run completes should fire');
  });

  it("overlap='queue' enqueues exactly one pending run", async () => {
    const timers = makeMockTimers();
    const scheduler = new JobScheduler({ log: () => {}, timers });
    let runs = 0;
    let pendingResolves: Array<() => void> = [];
    scheduler.register(
      ANY_AGENT,
      intervalSpec({ overlap: 'queue' }),
      async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          pendingResolves.push(resolve);
        });
      },
    );
    timers.tick();
    await flush();
    assert.equal(runs, 1);
    // Three more ticks while still running — queue should saturate at 1
    timers.tick();
    timers.tick();
    timers.tick();
    await flush();
    assert.equal(runs, 1, 'no new run starts while previous in flight');
    pendingResolves.shift()?.();
    await flush();
    assert.equal(runs, 2, 'queued run drains after previous completes');
    pendingResolves.shift()?.();
    await flush();
    assert.equal(runs, 2, 'no further runs beyond the single queued slot');
  });

  it('handler throws are logged but do not stop future ticks', async () => {
    const timers = makeMockTimers();
    const logs: string[] = [];
    const scheduler = new JobScheduler({ log: (m) => logs.push(m), timers });
    let runs = 0;
    scheduler.register(ANY_AGENT, intervalSpec(), async () => {
      runs += 1;
      throw new Error('boom');
    });
    timers.tick();
    await flush();
    timers.tick();
    await flush();
    assert.equal(runs, 2);
    assert.equal(
      logs.filter((l) => l.includes('boom')).length,
      2,
      'each throw is logged',
    );
  });

  it('dispose handle removes the registration and stops the trigger', () => {
    const timers = makeMockTimers();
    const scheduler = new JobScheduler({ log: () => {}, timers });
    const dispose = scheduler.register(ANY_AGENT, intervalSpec(), async () => {});
    assert.equal(timers.pendingIntervals(), 1);
    assert.equal(scheduler.list().length, 1);
    dispose();
    assert.equal(timers.pendingIntervals(), 0);
    assert.equal(scheduler.list().length, 0);
  });

  it('stopForPlugin removes every job belonging to the agent', () => {
    const timers = makeMockTimers();
    const scheduler = new JobScheduler({ log: () => {}, timers });
    scheduler.register(ANY_AGENT, intervalSpec({ name: 'a' }), async () => {});
    scheduler.register(ANY_AGENT, intervalSpec({ name: 'b' }), async () => {});
    scheduler.register('other', intervalSpec({ name: 'c' }), async () => {});
    assert.equal(scheduler.list().length, 3);
    scheduler.stopForPlugin(ANY_AGENT);
    const remaining = scheduler.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.agentId, 'other');
  });

  it('rejects duplicate (agentId, name) registrations', () => {
    const scheduler = new JobScheduler({ log: () => {} });
    scheduler.register(ANY_AGENT, intervalSpec(), async () => {});
    assert.throws(
      () => scheduler.register(ANY_AGENT, intervalSpec(), async () => {}),
      JobAlreadyRegisteredError,
    );
    scheduler.stopForPlugin(ANY_AGENT);
  });
});

describe('JobScheduler — spec validation', () => {
  const sched = (): JobScheduler => new JobScheduler({ log: () => {} });

  it('rejects empty name', () => {
    assert.throws(
      () => sched().register(ANY_AGENT, { name: '', schedule: { intervalMs: 1 } }, async () => {}),
      JobValidationError,
    );
  });

  it('rejects missing schedule', () => {
    assert.throws(
      () =>
        sched().register(
          ANY_AGENT,
          { name: 'x', schedule: undefined as unknown as JobSpec['schedule'] },
          async () => {},
        ),
      JobValidationError,
    );
  });

  it('rejects malformed cron', () => {
    assert.throws(
      () =>
        sched().register(
          ANY_AGENT,
          { name: 'x', schedule: { cron: 'not a cron' } },
          async () => {},
        ),
      JobValidationError,
    );
  });

  it('accepts well-formed cron', () => {
    const s = sched();
    const dispose = s.register(
      ANY_AGENT,
      { name: 'x', schedule: { cron: '*/5 * * * *' } },
      async () => {},
    );
    dispose();
  });

  it('rejects non-positive intervalMs', () => {
    assert.throws(
      () =>
        sched().register(
          ANY_AGENT,
          { name: 'x', schedule: { intervalMs: 0 } },
          async () => {},
        ),
      JobValidationError,
    );
    assert.throws(
      () =>
        sched().register(
          ANY_AGENT,
          { name: 'x', schedule: { intervalMs: -1 } },
          async () => {},
        ),
      JobValidationError,
    );
  });

  it('rejects non-positive timeoutMs', () => {
    assert.throws(
      () =>
        sched().register(
          ANY_AGENT,
          { name: 'x', schedule: { intervalMs: 1000 }, timeoutMs: 0 },
          async () => {},
        ),
      JobValidationError,
    );
  });

  it('rejects unknown overlap mode', () => {
    assert.throws(
      () =>
        sched().register(
          ANY_AGENT,
          {
            name: 'x',
            schedule: { intervalMs: 1000 },
            overlap: 'spawn' as unknown as 'skip',
          },
          async () => {},
        ),
      JobValidationError,
    );
  });
});

/** Drain microtasks. Three iterations covers
 *  (handler-promise → timeout-clear → potential queued runOnce). */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
  }
}
