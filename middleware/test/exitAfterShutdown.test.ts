import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { exitAfterShutdown } from '../src/platform/exitAfterShutdown.js';

function harness(cleanup: () => Promise<void>, timeoutMs = 20) {
  const exits: number[] = [];
  const logs: string[] = [];
  const handler = exitAfterShutdown(cleanup, {
    timeoutMs,
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
  });
  return { exits, logs, handler };
}

describe('exitAfterShutdown', () => {
  it('exits once the cleanup finished, not before', async () => {
    const order: string[] = [];
    const exits: number[] = [];
    const handler = exitAfterShutdown(
      async () => {
        await Promise.resolve();
        order.push('cleanup');
      },
      {
        exit: (code) => {
          order.push('exit');
          exits.push(code);
        },
      },
    );
    await handler();
    assert.deepEqual(order, ['cleanup', 'exit']);
    assert.deepEqual(exits, [0]);
  });

  it('exits when the cleanup hangs', async () => {
    const { exits, logs, handler } = harness(() => new Promise<void>(() => undefined));
    await handler();
    assert.deepEqual(exits, [0]);
    assert.match(logs[0] ?? '', /exiting anyway/);
  });

  it('exits when the cleanup throws', async () => {
    const { exits, logs, handler } = harness(() => Promise.reject(new Error('boom')));
    await handler();
    assert.deepEqual(exits, [0]);
    assert.match(logs[0] ?? '', /boom/);
  });

  it('runs the cleanup once for SIGTERM followed by SIGINT', async () => {
    let runs = 0;
    const { exits, handler } = harness(async () => {
      runs += 1;
    });
    await Promise.all([handler(), handler()]);
    assert.equal(runs, 1);
    assert.deepEqual(exits, [0]);
  });
});
