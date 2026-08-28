import { test, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Supervisor } from '../src/supervisor.ts';
import { __setEmbeddedDbHooks, type EmbeddedDb } from '../src/embeddedDb.ts';

/**
 * The restart()/stop() race (#927, third review round).
 *
 * These two are separate from supervisorLifecycle.test.mts because they need a
 * child process to gate restart()'s teardown on, which means reaching into the
 * supervisor's private fields. Kept together and clearly labelled rather than
 * mixed in with the tests that need no such thing.
 */

before(() => {
  // A boot in these tests is expected to fail after the database phase. Without
  // this it would poll a kernel that was never really started for 90 seconds.
  process.env['OMADIA_BOOT_TIMEOUT_MS'] = '30';
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** A child whose kill() throws, the way EPERM does against a vanished process. */
class ThrowingChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    throw new Error('kill EPERM');
  }
}

/** A child process that exits only when its gate is opened. */
class GatedChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(gate: Promise<void>) {
    super();
    void gate.then(() => {
      this.exitCode = 0;
      this.emit('exit');
    });
  }

  kill(): boolean {
    return true;
  }
}

/**
 * Put the supervisor into a "running with a kernel" state.
 *
 * Reaching into private fields on purpose: the alternative is a seam for child
 * spawning, and inventing one to describe a state the class already models
 * would be the more invasive change.
 */
function pretendRunning(sup: Supervisor, kernel: GatedChild): void {
  const internals = sup as unknown as {
    kernel: unknown;
    state: string;
    uiUrl: string | null;
  };
  internals.kernel = kernel;
  internals.state = 'running';
  internals.uiUrl = 'http://127.0.0.1:65535';
}

/** Read the private lifecycle fields, for failure messages only. */
function peek(sup: Supervisor): { state: string; stopping: boolean } {
  const internals = sup as unknown as { state: string; stopping: boolean };
  return { state: internals.state, stopping: internals.stopping };
}

function fakeHandle(stop: () => Promise<boolean>): EmbeddedDb {
  return { databaseUrl: 'postgresql://test', port: 1, stop };
}

afterEach(() => {
  __setEmbeddedDbHooks(null);
});

test('stop() during a restart must not report clean and then let the restart boot', async () => {
  const kernelExit = deferred();
  const portLookup = deferred();
  let dbRegistered = false;
  const events: string[] = [];

  __setEmbeddedDbHooks({
    start: async () => {
      events.push('db-start');
      // Models startEmbeddedDb(): the port lookup happens BEFORE the server is
      // registered in module state.
      await portLookup.promise;
      dbRegistered = true;
      events.push('db-registered');
      return fakeHandle(async () => {
        dbRegistered = false;
        return true;
      });
    },
    stop: async () => {
      events.push(`module-stop(registered=${dbRegistered})`);
      // Faithful to stopEmbeddedDb(): nothing registered means nothing to do.
      if (!dbRegistered) return true;
      dbRegistered = false;
      return true;
    },
    isRunning: () => dbRegistered,
  });

  const sup = new Supervisor();
  const kernel = new GatedChild(kernelExit.promise);
  pretendRunning(sup, kernel);

  const restarting = sup.restart();
  await settle();
  const stopping = sup.stop();
  await settle();

  // Let restart()'s teardown finish. Its stopChild listener was registered
  // first, so it observes the exit before the one stop() registered.
  kernelExit.resolve();
  const outcome = await stopping;
  events.push(`stop-resolved(clean=${outcome.clean})`);

  // Whatever the restart was doing, it may not bring a database up after stop()
  // has already told the updater the stack is down.
  portLookup.resolve();
  await restarting.catch(() => {});
  await settle();

  assert.equal(
    dbRegistered,
    false,
    `a database came up after stop() resolved; sequence: ${events.join(' / ')}`,
  );
});

test('restart() waits for an in-flight boot, so its own database is not killed from behind', async () => {
  const firstPort = deferred();
  const secondPort = deferred();
  let starts = 0;
  let dbRegistered = false;

  __setEmbeddedDbHooks({
    start: async () => {
      starts += 1;
      await (starts === 1 ? firstPort.promise : secondPort.promise);
      dbRegistered = true;
      // The real toHandle().stop() delegates to stopEmbeddedDb(), i.e. it kills
      // whatever is in module state - not necessarily the server this handle
      // was created for. That is exactly the hazard restart() has to avoid.
      return fakeHandle(async () => {
        dbRegistered = false;
        return true;
      });
    },
    stop: async () => {
      if (!dbRegistered) return true;
      dbRegistered = false;
      return true;
    },
    isRunning: () => dbRegistered,
  });

  const sup = new Supervisor();
  const firstBoot = sup.start();
  await settle();

  const restarting = sup.restart();
  await settle();

  // Let a second boot (if the restart started one) get its database up first,
  // then let the first, superseded boot finish and run its cleanup.
  secondPort.resolve();
  await settle();
  firstPort.resolve();
  await settle();

  await firstBoot.catch(() => {});
  await restarting.catch(() => {});
  await settle();

  assert.equal(starts, 2, 'the restart should have started its own database');
  assert.equal(
    dbRegistered,
    true,
    "the superseded boot's cleanup killed the database the restart had just started",
  );
});

test('restart() is refused once a shutdown has begun', async () => {
  const dbStopRelease = deferred();
  __setEmbeddedDbHooks({
    start: async () => fakeHandle(async () => true),
    stop: async () => {
      await dbStopRelease.promise;
      return true;
    },
    isRunning: () => false,
  });

  const sup = new Supervisor();
  const stopping = sup.stop();
  await settle();

  // `state` is not enough to express this on its own: a restart puts it back to
  // 'idle' before booting, so the shared flag is what the guard has to read.
  await assert.rejects(sup.restart(), /Cannot restart while stopping/);
  dbStopRelease.resolve();
  await stopping;

  // And it works again afterwards.
  await assert.rejects(sup.restart(), /^(?!Error: Cannot restart while stopping)/);
});

test('a boot is refused once a shutdown has begun', async () => {
  const dbStopRelease = deferred();
  let starts = 0;
  __setEmbeddedDbHooks({
    start: async () => {
      starts += 1;
      return fakeHandle(async () => true);
    },
    stop: async () => {
      await dbStopRelease.promise;
      return true;
    },
    isRunning: () => false,
  });

  const sup = new Supervisor();
  const stopping = sup.stop();
  await settle();

  await assert.rejects(sup.start(), /Cannot start while stopping/);
  assert.equal(starts, 0, 'no database may be started while shutting down');
  dbStopRelease.resolve();
  await stopping;
});

test('a boot landing while a superseded restart has reset the state is refused', async () => {
  // The three-actor interleaving. A restart loses to a stop at its supersession
  // re-check and sets state = 'idle' on the way out, while `stopping` is still
  // true and runStop() is only part-way through its own teardown. Any start()
  // arriving in that window sees an idle-looking supervisor, and only the
  // `stopping` guard turns it away - which is why that guard, and not the
  // re-check beside it, is the load-bearing one.
  //
  // main.ts reaches start() here for real: bootExistingInstall() via
  // app.on('activate') and via the "Re-run setup" button.
  const kernelExit = deferred();
  const dbStopGate = deferred();
  const latePortLookup = deferred();
  let dbStarts = 0;
  let dbRegistered = false;
  const events: string[] = [];

  __setEmbeddedDbHooks({
    start: async () => {
      dbStarts += 1;
      events.push(`db-start#${dbStarts}`);
      // Models startEmbeddedDb(): the port lookup precedes registration.
      await latePortLookup.promise;
      dbRegistered = true;
      events.push('db-registered');
      return fakeHandle(async () => {
        dbRegistered = false;
        return true;
      });
    },
    stop: async () => {
      // stopEmbeddedDb() decides on entry: `if (!current) return true`. The
      // snapshot here is what makes that faithful.
      const wasRegistered = dbRegistered;
      events.push(`module-stop(registered=${wasRegistered})`);
      await dbStopGate.promise;
      if (!wasRegistered) return true;
      dbRegistered = false;
      return true;
    },
    isRunning: () => dbRegistered,
  });

  const sup = new Supervisor();
  pretendRunning(sup, new GatedChild(kernelExit.promise));

  const restarting = sup.restart();
  await settle();
  const stopping = sup.stop();
  await settle();

  // Let the restart's teardown finish so it loses at the re-check.
  kernelExit.resolve();
  // Any rejection will do. Which message the restart loses with is not the
  // point, and asserting it here would make this test fail for a wording change
  // rather than for a safety leak.
  await restarting.catch(() => {});
  await settle();

  const window = peek(sup);
  events.push(`window(state=${window.state},stopping=${window.stopping})`);

  // The third actor.
  await assert.rejects(sup.start(), /Cannot start while stopping/);

  dbStopGate.resolve();
  const outcome = await stopping;
  events.push(`stop-resolved(clean=${outcome.clean},survivors=[${outcome.survivors.join(',')}])`);
  latePortLookup.resolve();
  await settle();

  assert.equal(
    dbStarts,
    0,
    `no database may be started during a shutdown; sequence: ${events.join(' / ')}`,
  );
  assert.equal(
    dbRegistered,
    false,
    `a database came up after stop() reported clean; sequence: ${events.join(' / ')}`,
  );
});

test('a kill() that throws is reported as a survivor, not raised out of stop()', async () => {
  let dbRegistered = true;
  let dbStops = 0;
  __setEmbeddedDbHooks({
    start: async () => fakeHandle(async () => true),
    stop: async () => {
      dbStops += 1;
      dbRegistered = false;
      return true;
    },
    isRunning: () => dbRegistered,
  });

  const sup = new Supervisor();
  pretendRunning(sup, new ThrowingChild() as unknown as GatedChild);

  // Before: this rejected with the raw EPERM. The database teardown was then
  // skipped (orphaning Postgres), `state` stayed wedged at 'stopping' so nothing
  // could start again, and the quit handler's second stop() failed identically.
  const outcome = await sup.stop();

  assert.equal(outcome.clean, false);
  assert.deepEqual(outcome.survivors, ['kernel']);
  assert.equal(dbStops >= 1, true, 'the database teardown must still have run');
  assert.equal(dbRegistered, false, 'Postgres must not be orphaned by a failed child kill');
  assert.equal(peek(sup).state, 'idle', 'the supervisor must not stay wedged in stopping');
});
