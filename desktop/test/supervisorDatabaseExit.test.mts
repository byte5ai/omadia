import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Supervisor, type DatabaseExit } from '../src/supervisor.ts';
import { __setEmbeddedDbHooks } from '../src/embeddedDb.ts';
import type { DesktopCapabilities } from '../src/capabilities.ts';

/**
 * The embedded database exiting while the kernel runs.
 *
 * The kernel's pools reconnect on demand to the address they were given, and
 * on Windows that is a loopback TCP port nobody holds while the server is
 * down. So the kernel must be gone before any database starts again: the
 * supervisor stops it (and the web-ui) as soon as the server exits, reports
 * `database-exit`, and the restart that follows starts the database before
 * the kernel. Ports and transports play no part in this ordering, so it runs
 * the same on every OS.
 *
 * Only the database and the kernel are doubles. Boots in these tests stop at
 * the capability read that comes right before the kernel would be spawned, so
 * no real child process starts.
 */

const NO_KERNEL = 'test boot ends before the kernel is spawned';

/** A boot reads the capability switches right before it spawns the kernel. */
function stopBeforeKernel(): DesktopCapabilities {
  throw new Error(NO_KERNEL);
}

/** Where a test boot ends: the capability read, or a busy kernel port on a machine running omadia. */
const bootEndedEarly = (err: Error): boolean => err.message === NO_KERNEL || /port 8769/i.test(err.message);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** A kernel double that records when it is told to stop and exits right after. */
class KernelDouble extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly events: string[];

  constructor(events: string[]) {
    super();
    this.events = events;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.events.push(`kernel-${signal ?? 'SIGTERM'}`);
    setImmediate(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = signal ?? 'SIGTERM';
      this.events.push('kernel-exited');
      this.emit('exit', null, this.signalCode);
    });
    return true;
  }
}

/** A database whose unexpected exit the test triggers. */
function databaseDouble(events: string[]): {
  exit: (reason: string) => void;
  starts: () => number;
} {
  let starts = 0;
  let listeners: Array<(reason: string) => void> = [];
  __setEmbeddedDbHooks({
    start: async () => {
      starts += 1;
      events.push('db-start');
      return {
        databaseUrl: 'postgresql://test',
        port: 1,
        stop: async () => true,
        onUnexpectedExit: (listener) => {
          listeners = [...listeners, listener];
        },
      };
    },
    stop: async () => true,
    isRunning: () => false,
  });
  return {
    exit: (reason) => {
      events.push('db-exited');
      const current = listeners;
      listeners = [];
      for (const listener of current) listener(reason);
    },
    starts: () => starts,
  };
}

/** Put a supervisor whose database is up into the running state, with `kernel` as its kernel. */
function pretendRunning(sup: Supervisor, kernel: KernelDouble): void {
  const internals = sup as unknown as { kernel: unknown; state: string; uiUrl: string | null };
  internals.kernel = kernel;
  internals.state = 'running';
  internals.uiUrl = 'http://127.0.0.1:65535';
}

afterEach(() => {
  __setEmbeddedDbHooks(null);
});

test('a database exit stops the kernel before the database starts again, then both come back in order', async () => {
  const events: string[] = [];
  const db = databaseDouble(events);
  const sup = new Supervisor({ capabilities: stopBeforeKernel });
  // A first boot starts the database and subscribes to its exit.
  await assert.rejects(sup.start());
  assert.equal(db.starts(), 1);

  const kernel = new KernelDouble(events);
  pretendRunning(sup, kernel);
  const exited = new Promise<DatabaseExit>((resolve) => sup.once('database-exit', resolve));
  sup.on('database-exit', () => events.push('database-exit'));

  db.exit('code=null signal=SIGKILL');
  const exit = await exited;
  assert.equal(exit.reason, 'code=null signal=SIGKILL');
  assert.deepEqual(events, ['db-start', 'db-exited', 'kernel-SIGTERM', 'kernel-exited', 'database-exit']);

  // What the app does on `database-exit`: the ordinary restart. It starts a
  // database of its own (the dead handle is gone) before it gets to the kernel.
  await assert.rejects(sup.restart(), bootEndedEarly);
  assert.equal(db.starts(), 2, 'the restart starts the database again');
  assert.deepEqual(events.slice(-2), ['database-exit', 'db-start']);
  assert.ok(
    events.indexOf('kernel-exited') < events.lastIndexOf('db-start'),
    'the kernel is gone before the database restarts',
  );
});

test('nothing can start the database again while the kernel is still being stopped', async () => {
  const events: string[] = [];
  const db = databaseDouble(events);
  const sup = new Supervisor({ capabilities: stopBeforeKernel });
  await assert.rejects(sup.start());

  // A kernel that takes its time to exit after SIGTERM.
  const kernel = new KernelDouble(events);
  kernel.kill = (signal?: NodeJS.Signals): boolean => {
    events.push(`kernel-${signal ?? 'SIGTERM'}`);
    return true;
  };
  pretendRunning(sup, kernel);

  db.exit('code=1 signal=null');
  await settle();
  await assert.rejects(sup.start(), /Cannot start while stopping/);
  await assert.rejects(sup.restart(), /Cannot restart while stopping/);
  assert.equal(db.starts(), 1, 'no database start while the kernel is alive');

  const exited = new Promise<void>((resolve) => sup.once('database-exit', () => resolve()));
  kernel.signalCode = 'SIGTERM';
  kernel.emit('exit', null, 'SIGTERM');
  await exited;
  assert.equal(db.starts(), 1);
});

test('a kernel that does not exit leaves the restart to the user', async () => {
  const events: string[] = [];
  const db = databaseDouble(events);
  const sup = new Supervisor({ capabilities: stopBeforeKernel });
  await assert.rejects(sup.start());

  // A kernel the shell cannot signal (kill() throws), so it may still be running.
  const kernel = new KernelDouble(events);
  kernel.kill = (): boolean => {
    throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' });
  };
  pretendRunning(sup, kernel);
  sup.on('database-exit', () => events.push('database-exit'));
  const phases: string[] = [];
  sup.on('progress', (progress: { phase: string }) => phases.push(progress.phase));

  db.exit('code=1 signal=null');
  await settle();
  assert.equal(events.includes('database-exit'), false, 'no automatic restart while the kernel may be alive');
  assert.deepEqual(phases, ['error']);
  assert.equal(db.starts(), 1);
});

test('a database that exits under a boot fails the boot before a kernel is spawned', async () => {
  let capabilitiesRead = 0;
  let starts = 0;
  __setEmbeddedDbHooks({
    start: async () => {
      starts += 1;
      return {
        databaseUrl: 'postgresql://test',
        port: 1,
        stop: async () => true,
        // The server is already gone when the boot subscribes, which the real
        // handle reports at once.
        onUnexpectedExit: (listener) => listener('the embedded Postgres was no longer running'),
      };
    },
    stop: async () => true,
    isRunning: () => false,
  });
  const sup = new Supervisor({
    capabilities: () => {
      capabilitiesRead += 1;
      return stopBeforeKernel();
    },
  });

  await assert.rejects(sup.start(), /the embedded database stopped while omadia was starting/);
  assert.equal(capabilitiesRead, 0, 'the boot stopped before it would spawn a kernel');

  // The dead handle is not reused: the next boot starts a database of its own.
  await assert.rejects(sup.start(), /the embedded database stopped while omadia was starting/);
  assert.equal(starts, 2);
});

test('a stopped database does not trigger a restart', async () => {
  const events: string[] = [];
  const db = databaseDouble(events);
  const sup = new Supervisor({ capabilities: stopBeforeKernel });
  await assert.rejects(sup.start());
  const kernel = new KernelDouble(events);
  pretendRunning(sup, kernel);
  sup.on('database-exit', () => events.push('database-exit'));

  const outcome = await sup.stop();
  // An exit that a full shutdown caused is not one to recover from: the handle
  // is gone by the time a late notification could arrive.
  db.exit('code=0 signal=null');
  await settle();
  assert.equal(outcome.clean, true);
  assert.equal(events.includes('database-exit'), false);
  assert.equal(db.starts(), 1);
});
