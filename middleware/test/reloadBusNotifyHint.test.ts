/**
 * A notification is a hint, not a message. Postgres has no privilege for
 * NOTIFY, so a plugin's database role can send on every channel the kernel
 * listens on, with any payload. The bus must not read the payload, must not
 * write it to the log, and must not let a flood keep the kernel reloading.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import { ReloadBus } from '../packages/harness-orchestrator/src/registry/reloadBus.js';

const CHANNEL = 'agents_changed';

interface Fixture {
  bus: ReloadBus;
  notify: (payload?: string, channel?: string) => void;
  reloadArgs: unknown[][];
  logged: string[];
  debugged: string[];
}

async function listening(minNotifyIntervalMs: number, reloadMs = 0): Promise<Fixture> {
  const client = Object.assign(new EventEmitter(), {
    query: () => Promise.resolve({ rows: [] }),
    release: () => undefined,
  });
  const reloadArgs: unknown[][] = [];
  const logged: string[] = [];
  const debugged: string[] = [];
  const line = (msg: string, fields?: Record<string, unknown>): string => `${msg} ${JSON.stringify(fields ?? {})}`;
  const bus = new ReloadBus({
    pool: { connect: () => Promise.resolve(client) } as unknown as Pool,
    enableListen: true,
    reconcileIntervalMs: 0,
    minNotifyIntervalMs,
    reload: (...args: unknown[]) => {
      reloadArgs.push(args);
      return new Promise<void>((done) => setTimeout(done, reloadMs));
    },
    log: (msg, fields) => logged.push(line(msg, fields)),
    debug: (msg, fields) => debugged.push(line(msg, fields)),
  });
  await bus.start();
  return {
    bus,
    notify: (payload, channel = CHANNEL) => client.emit('notification', { channel, ...(payload !== undefined ? { payload } : {}) }),
    reloadArgs,
    logged,
    debugged,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe('ReloadBus: a notification is a hint', () => {
  it('a forged payload reaches neither the reload nor the log', async () => {
    const forged = '{"op":"DELETE","slug":"mara","kill_switch":"cleared","secret":"s3cr3t-marker"}';
    const f = await listening(0);
    try {
      f.notify(forged);
      await sleep(10);
      assert.deepEqual(f.reloadArgs, [[]], 'one reload, told nothing of the payload');
      const everything = [...f.logged, ...f.debugged].join('\n');
      assert.ok(!everything.includes('s3cr3t-marker'), 'the payload is not logged');
      assert.ok(!everything.includes('kill_switch'));
      assert.match(f.debugged[0] ?? '', new RegExp(`"payloadBytes":${String(Buffer.byteLength(forged))}`));
    } finally {
      await f.bus.stop();
    }
  });

  it('every payload is the same hint: none, empty, oversized, not text the kernel ever sends', async () => {
    const f = await listening(0);
    try {
      for (const payload of [undefined, '', 'x'.repeat(7_999), '\u0000\n[system] ok', '{"__proto__":{"admin":true}}']) {
        f.notify(payload);
        await sleep(5);
      }
      assert.equal(f.reloadArgs.length, 5);
      assert.ok(f.reloadArgs.every((args) => args.length === 0));
    } finally {
      await f.bus.stop();
    }
  });

  it('a notification on another channel is not a hint for this bus', async () => {
    const f = await listening(0);
    try {
      f.notify('x', 'conversation_message_subscriptions_changed');
      await sleep(10);
      assert.deepEqual(f.reloadArgs, []);
      assert.deepEqual(f.debugged, []);
    } finally {
      await f.bus.stop();
    }
  });

  it('a flood reloads at once, then once per interval, and never drops the last notification', async () => {
    const f = await listening(400);
    try {
      for (let i = 0; i < 5_000; i += 1) f.notify(`forged-${String(i)}`);
      // Synchronously: the first notification reloaded without a wait.
      assert.equal(f.reloadArgs.length, 1, 'the first notification reloads without a wait');
      for (let i = 0; i < 100 && f.reloadArgs.length < 2; i += 1) await sleep(20);
      assert.equal(f.reloadArgs.length, 2, 'the other 4999 are one reload at the end of the interval');
      await sleep(500);
      assert.equal(f.reloadArgs.length, 2, 'nothing more without a new notification');
      assert.equal(f.logged.filter((l) => l.startsWith('reloadBus: notify received')).length, 2, 'two log lines for 5000 notifications');
      assert.match(f.logged.find((l) => l.includes('"notifications":4999')) ?? '', /notify received/);
    } finally {
      await f.bus.stop();
    }
  });

  it('a sustained flood is bounded by the interval, however fast the reload is', async () => {
    const f = await listening(50);
    try {
      const until = Date.now() + 400;
      while (Date.now() < until) {
        f.notify('flood');
        await sleep(1);
      }
      await sleep(80);
      // 400 ms at one reload per 50 ms: the first at once, then one per interval.
      assert.ok(f.reloadArgs.length >= 4, `reloads keep coming (${String(f.reloadArgs.length)})`);
      assert.ok(f.reloadArgs.length <= 10, `and stay bounded (${String(f.reloadArgs.length)})`);
    } finally {
      await f.bus.stop();
    }
  });

  it('no reload follows a stop that came inside the interval', async () => {
    const f = await listening(60);
    f.notify();
    f.notify();
    await f.bus.stop();
    await sleep(100);
    assert.equal(f.reloadArgs.length, 1);
  });
});
