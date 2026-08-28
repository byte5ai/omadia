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
