import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../src/supervisor.ts';
import { __setEmbeddedDbHooks, type EmbeddedDb } from '../src/embeddedDb.ts';

/**
 * The two #927 lifecycle transitions that the child-shutdown tests cannot
 * reach: the shared in-flight stop() promise, and the generation race between
 * stop() and a boot that is still starting the database.
 *
 * Only the database is faked. That is enough on purpose - both defects happen
 * during the `starting-db` phase, before any child process is spawned - so the
 * real teardown, generation and single-flight code all run unmodified.
 */

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

/** Lets the microtask queue drain so an in-flight boot reaches its next await. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function fakeHandle(stop: () => Promise<boolean>): EmbeddedDb {
  return { databaseUrl: 'postgresql://test', port: 1, stop };
}

afterEach(() => {
  __setEmbeddedDbHooks(null);
});

test('concurrent stop() calls share one shutdown and one outcome', async () => {
  let stopCalls = 0;
  const release = deferred();
  __setEmbeddedDbHooks({
    start: async () => fakeHandle(async () => true),
    stop: async () => {
      stopCalls += 1;
      await release.promise;
      return true;
    },
    isRunning: () => false,
  });

  const sup = new Supervisor();
  const first = sup.stop();
  const second = sup.stop();
  await settle();
  release.resolve();
  const [a, b] = await Promise.all([first, second]);

  // The defect: the second call used to return immediately over a shutdown that
  // was still running, handing its caller a fulfilled promise.
  assert.equal(stopCalls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.clean, true);
  assert.deepEqual(a.survivors, []);
});

test('a stop() during database startup leaves no orphaned database', async () => {
  const portLookup = deferred();
  let dbLive = false;
  __setEmbeddedDbHooks({
    // Models startEmbeddedDb(): it awaits a free port BEFORE registering the
    // server, which is the window the old code walked straight through.
    start: async () => {
      await portLookup.promise;
      dbLive = true;
      return fakeHandle(async () => {
        dbLive = false;
        return true;
      });
    },
    stop: async () => {
      dbLive = false;
      return true;
    },
    isRunning: () => dbLive,
  });

  const sup = new Supervisor();
  const boot = sup.start();
  await settle();
  const stopping = sup.stop();
  await settle();
  portLookup.resolve();

  await assert.rejects(boot, /boot superseded/);
  const outcome = await stopping;

  // The regression: stop() saw no registered database, reported clean, and the
  // boot then published a live Postgres running out of the app bundle the
  // installer was about to replace.
  assert.equal(dbLive, false, 'the database started by the superseded boot must be stopped');
  assert.equal(outcome.clean, true);
});

test('a boot superseded after the database started leaves no stale handle behind', async () => {
  const portLookup = deferred();
  let startCalls = 0;
  __setEmbeddedDbHooks({
    start: async () => {
      startCalls += 1;
      if (startCalls === 1) await portLookup.promise;
      return fakeHandle(async () => true);
    },
    stop: async () => true,
    isRunning: () => false,
  });

  const sup = new Supervisor();
  const boot = sup.start();
  await settle();
  const stopping = sup.stop();
  await settle();
  portLookup.resolve();
  await assert.rejects(boot, /boot superseded/);
  await stopping;

  // The next boot must start a database again. Publishing the handle of a server
  // stop() had already killed made the next start() skip startEmbeddedDb() and
  // wait out a 90s health timeout against a dead port.
  await assert.rejects(sup.start());
  assert.equal(startCalls, 2, 'the next boot must start its own database');
});

test('a survivor from a superseded boot is folded into the stop outcome', async () => {
  const portLookup = deferred();
  __setEmbeddedDbHooks({
    start: async () => {
      await portLookup.promise;
      // This boot's own database refuses to die.
      return fakeHandle(async () => false);
    },
    stop: async () => true,
    isRunning: () => false,
  });

  const sup = new Supervisor();
  const boot = sup.start();
  await settle();
  const stopping = sup.stop();
  await settle();
  portLookup.resolve();
  await assert.rejects(boot, /boot superseded/);
  const outcome = await stopping;

  // stop() never used to await a superseded boot's cleanup, so a survivor it
  // produced was invisible and the outcome was reported clean.
  assert.equal(outcome.clean, false);
  assert.deepEqual(outcome.survivors, ['embedded-postgres']);
});

test('stop() does not resolve before a superseded boot has finished cleaning up', async () => {
  const portLookup = deferred();
  const dbStopRelease = deferred();
  const events: string[] = [];
  __setEmbeddedDbHooks({
    start: async () => {
      await portLookup.promise;
      return fakeHandle(async () => {
        await dbStopRelease.promise;
        events.push('boot-cleanup-done');
        return true;
      });
    },
    stop: async () => true,
    isRunning: () => false,
  });

  const sup = new Supervisor();
  const boot = sup.start();
  await settle();
  const stopping = sup.stop().then(() => events.push('stop-resolved'));
  await settle();
  portLookup.resolve();
  await settle();

  assert.deepEqual(events, [], 'neither should have completed while cleanup is blocked');
  dbStopRelease.resolve();
  await assert.rejects(boot, /boot superseded/);
  await stopping;

  assert.deepEqual(events, ['boot-cleanup-done', 'stop-resolved']);
});

test('a second database is reaped when it is registered after the first stop attempt', async () => {
  let registered = false;
  __setEmbeddedDbHooks({
    start: async () => fakeHandle(async () => true),
    stop: async () => {
      // First call finds nothing, then something appears: the exact shape of a
      // boot that registers its server after the stop already ran.
      if (!registered) {
        registered = true;
        return true;
      }
      registered = false;
      return true;
    },
    isRunning: () => registered,
  });

  const sup = new Supervisor();
  const outcome = await sup.stop();

  // isEmbeddedDbRunning() exists for exactly this re-check; leaving it unused
  // was the tell that the window had been missed.
  assert.equal(registered, false, 'the late-registered database must be stopped too');
  assert.equal(outcome.clean, true);
});

test('restart() is refused while a full stop is in flight', async () => {
  const release = deferred();
  __setEmbeddedDbHooks({
    start: async () => fakeHandle(async () => true),
    stop: async () => {
      await release.promise;
      return true;
    },
    isRunning: () => false,
  });

  const sup = new Supervisor();
  const stopping = sup.stop();
  await settle();
  await assert.rejects(sup.restart(), /Cannot restart while stopping/);
  release.resolve();
  await stopping;
});
