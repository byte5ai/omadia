import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  isConfirmedStopped,
  stopChild,
  type ChildStopOutcome,
  type StoppableChild,
} from '../src/childLifecycle.ts';

/**
 * A child process double. `exits` controls whether the fake ever emits 'exit',
 * which is the whole point: the desktop update loop was caused by a child that
 * never did, resolving identically to one that did (#927).
 */
class FakeChild extends EventEmitter implements StoppableChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  // An explicit field rather than a parameter property: node's strip-only
  // TypeScript mode (which is what runs these tests) rejects those.
  readonly exitOn: NodeJS.Signals | null;

  constructor(exitOn: NodeJS.Signals | null) {
    super();
    this.exitOn = exitOn;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exitOn !== null && signal === this.exitOn) {
      this.exitCode = 0;
      setImmediate(() => this.emit('exit'));
    }
    return true;
  }
}

const silentLogger = { warn: (): void => {} };

function collectingLogger(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

test('a null child is already gone', async () => {
  assert.equal(await stopChild(null, 'kernel', silentLogger, 10), 'already-exited');
});

test('a child that has already exited is not signalled again', async () => {
  const child = new FakeChild(null);
  child.exitCode = 0;
  assert.equal(await stopChild(child, 'kernel', silentLogger, 10), 'already-exited');
  assert.deepEqual(child.signals, []);
});

test('a child that honours SIGTERM reports a real exit', async () => {
  const child = new FakeChild('SIGTERM');
  const outcome = await stopChild(child, 'kernel', silentLogger, 50);
  assert.equal(outcome, 'exited');
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(isConfirmedStopped(outcome), true);
});

test('a child that ignores SIGTERM is escalated to SIGKILL and still reports an exit', async () => {
  const child = new FakeChild('SIGKILL');
  const logger = collectingLogger();
  const outcome = await stopChild(child, 'web-ui', logger, 20);
  assert.equal(outcome, 'exited');
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(
    logger.messages.some((m) => m.includes('did not exit on SIGTERM')),
    true,
  );
});

test('a child that never exits resolves as deadline, not as stopped', async () => {
  const child = new FakeChild(null);
  const logger = collectingLogger();
  const outcome: ChildStopOutcome = await stopChild(child, 'kernel', logger, 20);
  // The backstop must still fire so shutdown cannot hang forever...
  assert.equal(outcome, 'deadline');
  // ...but the caller must be able to tell that it did.
  assert.equal(isConfirmedStopped(outcome), false);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(
    logger.messages.some((m) => m.includes('giving up waiting')),
    true,
  );
});

test('a late exit event cannot flip an already-reported deadline', async () => {
  const child = new FakeChild(null);
  const outcome = await stopChild(child, 'kernel', silentLogger, 20);
  assert.equal(outcome, 'deadline');
  child.exitCode = 0;
  child.emit('exit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome, 'deadline');
});

test('a child that exits synchronously from kill() still resolves', async () => {
  // A double can do this even though a real ChildProcess defers 'exit' through
  // libuv. finish() used to run before the timer consts were initialised and
  // rejected with a ReferenceError, which is precisely the "stopping can throw"
  // case the rest of this module rules out.
  class SyncExitChild extends EventEmitter implements StoppableChild {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    kill(): boolean {
      this.exitCode = 0;
      this.emit('exit');
      return true;
    }
  }

  const outcome = await stopChild(new SyncExitChild(), 'kernel', silentLogger, 20);
  assert.equal(outcome, 'exited');
  assert.equal(isConfirmedStopped(outcome), true);
});

test('a kill() that throws resolves as kill-failed instead of rejecting', async () => {
  class ThrowingKillChild extends EventEmitter implements StoppableChild {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    kill(): boolean {
      throw new Error('kill EPERM');
    }
  }

  const logger = collectingLogger();
  const started = Date.now();
  const outcome = await stopChild(new ThrowingKillChild(), 'kernel', logger, 4_000);

  assert.equal(outcome, 'kill-failed');
  assert.equal(isConfirmedStopped(outcome), false);
  // Resolves at once rather than leaking the escalation timers and letting the
  // SIGKILL retry throw uncaught 4s later.
  assert.ok(Date.now() - started < 1_000, 'must not wait out the escalation timers');
  assert.equal(
    logger.messages.some((m) => m.includes('SIGTERM failed')),
    true,
  );
});
