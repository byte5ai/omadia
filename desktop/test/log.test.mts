/**
 * The desktop log is flushed before the app exits (FU-162).
 *
 * `log.ts` writes through an async `fs.WriteStream`, and the `before-quit`
 * handler calls `app.exit(0)` right after the supervisor stops. The last lines
 * of a shutdown (`[boot] shutdown incomplete`, `[main] shutdown error: …`) could
 * still be queued when the process died. `flushLog()` resolves once every line
 * written so far is in the file. It resolves at once when nothing was written,
 * and it is bounded, so a disk that never answers cannot hold the exit.
 *
 * Runs against the Electron fake, where `app.getPath('userData')` is a fresh
 * temp dir per test process. The stream is module state, so the order of the
 * first cases matters. The stuck-disk case loads its own copy of the module.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { Writable } from 'node:stream';

import { LOG_FLUSH_TIMEOUT_MS, flushLog, log, logFile } from '../src/log.ts';

type LogModule = typeof import('../src/log.ts');

/** A second, independent copy of `log.ts`, with its own stream, not yet opened. */
async function freshLogModule(tag: string): Promise<LogModule> {
  const specifier = `../src/log.ts?${tag}`;
  return (await import(specifier)) as LogModule;
}

/** The lines in the log file so far; none while it does not exist. */
function linesInFile(): string[] {
  if (!fs.existsSync(logFile())) return [];
  return fs
    .readFileSync(logFile(), 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

describe('flushLog', () => {
  it('resolves at once when nothing was ever written, and opens no file', async () => {
    await flushLog();
    assert.equal(fs.existsSync(logFile()), false);
  });

  it('resolves only once every line written so far is in the file', async (t) => {
    // Every line is mirrored to the console as well; keep the test output readable.
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    const count = 300;
    for (let i = 0; i < count; i++) log.info(`[test] line ${i} ${'x'.repeat(200)}`);
    log.error('[main] shutdown error: synthetic');
    // The stream opens the file asynchronously, so all of it is still queued.
    // This is what `app.exit(0)` used to cut off.
    assert.equal(linesInFile().length, 0, 'precondition: nothing has reached the file yet');

    await flushLog();

    const written = linesInFile();
    assert.equal(written.length, count + 1);
    assert.match(written.at(-1) ?? '', /\[ERROR\] \[main\] shutdown error: synthetic$/);
  });

  it('keeps the log usable after a flush', async (t) => {
    t.mock.method(console, 'log', () => {});
    log.warn('[boot] shutdown incomplete: synthetic');
    await Promise.all([flushLog(), flushLog()]);
    assert.match(linesInFile().at(-1) ?? '', /\[WARN\] \[boot\] shutdown incomplete: synthetic$/);
  });

  it('gives up after a bound when the disk never answers, so it cannot hold the exit', async (t) => {
    t.mock.method(console, 'log', () => {});
    // A stream whose writes never complete, like a hung network drive.
    const neverWrites = (() => new Writable({ write() {} })) as unknown as typeof fs.createWriteStream;
    t.mock.method(fs, 'createWriteStream', neverWrites);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stuck = await freshLogModule('stuck-disk');
    stuck.log.info('[main] shutdown error: synthetic');

    let settled = false;
    const flushed = stuck.flushLog().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'still waiting on the disk');

    t.mock.timers.tick(LOG_FLUSH_TIMEOUT_MS);
    await flushed;
    assert.equal(settled, true);
  });
});
