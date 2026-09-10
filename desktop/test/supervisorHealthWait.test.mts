import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Supervisor } from '../src/supervisor.ts';
import { onLog, type LogLevel } from '../src/log.ts';

/**
 * OM-88: exercise the real boot wait and log readers without starting Postgres
 * or Electron. As in supervisorRestartRace.test.mts, the typed private view
 * describes lifecycle states the class already has; no production-only test
 * seam is needed. Real children cover stdout/stderr capture, while an exit
 * double makes the ordering of stop(), fetch and listener cleanup explicit.
 */
interface SupervisorInternals {
  generation: number;
  kernel: ChildProcess | null;
  forkNode(
    entry: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    label: string,
    gen: number,
  ): ChildProcess;
  waitForHttp(
    url: string,
    timeoutMs: number,
    label: string,
    gen: number,
    child: ChildProcess,
  ): Promise<void>;
  teardownChildren(): Promise<string[]>;
}

function internals(sup: Supervisor): SupervisorInternals {
  return sup as unknown as SupervisorInternals;
}

class ExitChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    // Represents forkNode's permanent runtime-exit logger, which the wait must
    // leave alone when it removes its own temporary boot listener.
    this.on('exit', () => {});
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exit(null, signal);
    return true;
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function wait(
  sup: Supervisor,
  child: ChildProcess,
  timeoutMs = 90_000,
  label = 'kernel',
): Promise<void> {
  return internals(sup).waitForHttp(
    'http://127.0.0.1:65535/health', timeoutMs, label, internals(sup).generation, child,
  );
}

async function spawnFixture(
  t: TestContext,
  sup: Supervisor,
  source: string,
  label = 'kernel',
): Promise<ChildProcess> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'omadia-health-wait-'));
  const entry = path.join(dir, 'child.mjs');
  await writeFile(entry, source);
  const child = internals(sup).forkNode(entry, dir, process.env, label, internals(sup).generation);
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  return child;
}

function unavailable(t: TestContext): () => number {
  const request = t.mock.method(globalThis, 'fetch', async (): Promise<Response> => new Response(null, { status: 503 }));
  return () => request.mock.callCount();
}

function pendingFetch(t: TestContext): () => AbortSignal {
  let observedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    assert.ok(signal, 'the request must retain a bounded abort signal');
    observedSignal = signal;
    return new Promise<Response>((_resolve, reject) => {
      // A real fetch observes its AbortSignal. Keep this double faithful, with
      // a ref'ed backstop because AbortSignal.timeout itself does not keep Node
      // alive while this test awaits the request deadline.
      const backstop = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('test fetch did not receive cancellation'));
      }, 2_000);
      const onAbort = (): void => {
        clearTimeout(backstop);
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  });
  return () => {
    assert.ok(observedSignal, 'the request must have started');
    return observedSignal;
  };
}

test('OM-88: a real child crash rejects a 90s boot wait in under 2s with its last fatal line', async (t) => {
  const requestSignal = pendingFetch(t);
  const sup = new Supervisor();
  const child = await spawnFixture(t, sup, `
    import { setTimeout as delay } from 'node:timers/promises';
    process.stdout.write('error: initial provider failure\\nordinary stdout\\n');
    await delay(40);
    process.stderr.write('ERROR: retry failed\\nFaTaL: duplicate provider registration\\nordinary stderr\\n');
    await delay(40);
    process.exitCode = 1;
  `);
  const baseline = child.listenerCount('exit');
  const started = performance.now();

  await assert.rejects(wait(sup, child), {
    message: 'kernel exited with code 1 before becoming healthy: FaTaL: duplicate provider registration',
  });

  const elapsedMs = performance.now() - started;
  t.diagnostic(`OM-88 headline elapsed: ${elapsedMs.toFixed(2)}ms (deadline: 90000ms)`);
  assert.ok(elapsedMs < 2_000, `crash took ${elapsedMs.toFixed(2)}ms to reject`);
  assert.equal(requestSignal().aborted, true, 'the losing HTTP request must be cancelled');
  assert.equal(child.listenerCount('exit'), baseline);
  assert.equal(child.stdout?.listenerCount('data'), 1, 'reuse the existing stdout reader');
  assert.equal(child.stderr?.listenerCount('data'), 1, 'reuse the existing stderr reader');
});

test('OM-88: the last stdout error supersedes stderr fatal output captured before the wait', async (t) => {
  unavailable(t);
  const sup = new Supervisor();
  const child = await spawnFixture(t, sup, `
    import { setTimeout as delay } from 'node:timers/promises';
    process.stderr.write('FATAL: earlier stderr failure\\n');
    await delay(40);
    process.stdout.write('ErRoR: final stdout failure\\nordinary output\\n');
    process.exitCode = 1;
  `);
  await once(child, 'close');
  assert.equal(child.exitCode, 1);
  const baseline = child.listenerCount('exit');

  await assert.rejects(wait(sup, child), {
    message: 'kernel exited with code 1 before becoming healthy: ErRoR: final stdout failure',
  });
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: a fatal line split across chunks is retained even without a final newline', async (t) => {
  unavailable(t);
  const sup = new Supervisor();
  const child = await spawnFixture(t, sup, `
    import { setTimeout as delay } from 'node:timers/promises';
    process.stderr.write('Fa');
    await delay(30);
    process.stderr.write('TaL: split provider failure');
    await delay(30);
    process.exitCode = 1;
  `);
  await assert.rejects(wait(sup, child), {
    message: 'kernel exited with code 1 before becoming healthy: FaTaL: split provider failure',
  });
});

test('OM-88: logs stay per label and a replacement cannot inherit the previous child error', async (t) => {
  unavailable(t);
  const sup = new Supervisor();
  const oldChild = await spawnFixture(t, sup, "console.error('FATAL: previous boot'); process.exitCode = 1;");
  await assert.rejects(wait(sup, oldChild), /FATAL: previous boot$/);

  const uiChild = await spawnFixture(t, sup, "console.log('ordinary startup'); process.exitCode = 1;", 'web-ui');
  await assert.rejects(wait(sup, uiChild, 90_000, 'web-ui'), {
    message: 'web-ui exited with code 1 before becoming healthy: no error output captured',
  });

  const newChild = await spawnFixture(t, sup, "console.log('ordinary startup'); process.exitCode = 1;");
  // A stream may still deliver buffered data after its process exited. The
  // replacement owns this label now, so the previous reader must not refill it.
  const logged: Array<{ readonly level: LogLevel; readonly message: string }> = [];
  const unsubscribe = onLog((level, message) => logged.push({ level, message }));
  try {
    oldChild.stdout?.emit('data', Buffer.from('first line\nsecond line\n'));
    oldChild.stderr?.emit('data', Buffer.from('ERROR: late output from previous boot\n'));
  } finally {
    unsubscribe();
  }
  assert.deepEqual(logged, [
    { level: 'INFO', message: '[kernel] first line\nsecond line' },
    { level: 'WARN', message: '[kernel] ERROR: late output from previous boot' },
  ], 'the original log levels, prefixes and chunk formatting remain unchanged');
  await assert.rejects(wait(sup, newChild), {
    message: 'kernel exited with code 1 before becoming healthy: no error output captured',
  });
});

test('OM-88: a signal exit rejects while an HTTP request is still pending', async (t) => {
  const requestSignal = pendingFetch(t);
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  const waiting = wait(sup, child.asChild());
  const rejected = assert.rejects(waiting, {
    message: 'kernel exited with signal SIGKILL before becoming healthy: no error output captured',
  });
  child.exit(null, 'SIGKILL');
  await rejected;
  assert.equal(requestSignal().aborted, true, 'the losing HTTP request must be cancelled');
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: a crash interrupts the interval between HTTP polls immediately', async (t) => {
  const fetchCalls = unavailable(t);
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  const waiting = wait(sup, child.asChild());
  const rejected = assert.rejects(waiting, /exited with code 2.*no error output captured/);
  await nextTurn();
  const started = performance.now();
  child.exit(2);
  await rejected;
  assert.ok(performance.now() - started < 500, 'the exit must beat the next 750ms poll tick');
  await nextTurn();
  assert.equal(fetchCalls(), 1, 'the losing poll must not start another HTTP request');
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: teardown generation bump and kill retain boot superseded and remove the listener', async (t) => {
  pendingFetch(t);
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  internals(sup).kernel = child.asChild();
  const waiting = wait(sup, child.asChild());
  const rejected = assert.rejects(waiting, { message: 'boot superseded' });

  // Use the same lifecycle idiom as supervisorRestartRace: only the process is
  // doubled; production teardown performs the generation bump before kill().
  assert.deepEqual(await internals(sup).teardownChildren(), []);
  await rejected;
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: a superseded generation wins even if the child was already dead', async (t) => {
  unavailable(t);
  const sup = new Supervisor();
  const child = new ExitChild();
  const gen = internals(sup).generation;
  const baseline = child.listenerCount('exit');
  child.exit(1);
  await internals(sup).teardownChildren();

  await assert.rejects(internals(sup).waitForHttp(
    'http://127.0.0.1:65535/health', 90_000, 'kernel', gen, child.asChild(),
  ), { message: 'boot superseded' });
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: supersession during the final poll sleep wins over the health timeout', async (t) => {
  unavailable(t);
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  const waiting = wait(sup, child.asChild(), 60);
  const rejected = assert.rejects(waiting, { message: 'boot superseded' });
  await nextTurn();
  internals(sup).generation += 1;
  await rejected;

  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(child.listenerCount('exit'), baseline);
});

for (const exit of [
  { code: 1, signal: null, reason: 'code 1' },
  { code: null, signal: 'SIGTERM', reason: 'signal SIGTERM' },
] satisfies ReadonlyArray<{ code: number | null; signal: NodeJS.Signals | null; reason: string }>) {
  test(`OM-88: a child already exited with ${exit.reason} wins over a healthy HTTP reply`, async (t) => {
    t.mock.method(globalThis, 'fetch', async (): Promise<Response> => new Response(null));
    const sup = new Supervisor();
    const child = new ExitChild();
    child.exit(exit.code, exit.signal);
    const baseline = child.listenerCount('exit');

    await assert.rejects(wait(sup, child.asChild()), {
      message: `kernel exited with ${exit.reason} before becoming healthy: no error output captured`,
    });
    assert.equal(child.listenerCount('exit'), baseline);
  });
}

for (const alreadyExited of [false, true]) {
  test(`OM-88: clean code 0 ${alreadyExited ? 'before' : 'during'} the wait preserves the HTTP deadline`, async (t) => {
    unavailable(t);
    const sup = new Supervisor();
    const child = new ExitChild();
    if (alreadyExited) child.exit(0);
    const baseline = child.listenerCount('exit');
    const started = performance.now();
    const waiting = wait(sup, child.asChild(), 60);
    const rejected = assert.rejects(waiting, { message: 'kernel did not become healthy within 60ms (HTTP 503)' });
    if (!alreadyExited) child.exit(0);
    await rejected;

    assert.ok(performance.now() - started >= 50, 'a clean exit must not resolve or reject the wait early');
    assert.equal(child.listenerCount('exit'), baseline);
  });
}

test('OM-88: a clean exit during a request still allows a healthy response', async (t) => {
  let respond!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', (): Promise<Response> => new Promise<Response>((resolve) => {
    respond = resolve;
  }));
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  const waiting = wait(sup, child.asChild());
  child.exit(0);
  respond(new Response(null));
  await waiting;
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: a successful wait removes its listener before any later child exit', async (t) => {
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> => new Response(null));
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  await wait(sup, child.asChild());
  assert.equal(child.listenerCount('exit'), baseline);

  child.exit(1);
  await nextTurn();
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: the deadline still bounds a pending HTTP request and removes the listener', async (t) => {
  pendingFetch(t);
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  const started = performance.now();
  await assert.rejects(wait(sup, child.asChild(), 60), /kernel did not become healthy within 60ms/);
  assert.ok(performance.now() - started < 2_000, 'the fetch cannot extend the health deadline');
  assert.equal(child.listenerCount('exit'), baseline);
});

test('OM-88: the final HTTP error remains in the timeout message', async (t) => {
  t.mock.method(globalThis, 'fetch', async (): Promise<Response> => {
    throw new Error('ECONNREFUSED health endpoint');
  });
  const sup = new Supervisor();
  const child = new ExitChild();
  const baseline = child.listenerCount('exit');
  await assert.rejects(wait(sup, child.asChild(), 40), {
    message: 'kernel did not become healthy within 40ms (ECONNREFUSED health endpoint)',
  });
  assert.equal(child.listenerCount('exit'), baseline);
});
