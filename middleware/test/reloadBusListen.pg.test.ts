/**
 * The reload bus with a LISTEN connection of its own, against a real
 * Postgres: a NOTIFY reaches the bus through the address it was given, and
 * the pool it was also given loses no connection to it.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ReloadBus } from '../packages/harness-orchestrator/src/registry/reloadBus.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'reloadBusListen',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

describe('ReloadBus LISTEN on its own connection (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  const channel = `reload_bus_test_${String(process.pid)}`;

  before(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  after(async () => {
    await pool.end();
  });

  const until = async (condition: () => boolean, ms = 5_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  };

  it('a NOTIFY fires the reload; the pool keeps all its connections', async () => {
    let reloads = 0;
    const bus = new ReloadBus({
      pool,
      listenConnectionString: PG_URL!,
      channel,
      enableListen: true,
      reconcileIntervalMs: 0,
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    await bus.start();
    try {
      assert.equal(pool.totalCount - pool.idleCount, 0, 'the bus holds no pooled connection');
      await pool.query(`NOTIFY ${channel}, 'changed'`);
      await until(() => reloads > 0);
      assert.equal(reloads, 1);
    } finally {
      await bus.stop();
    }
    // After stop the session is gone: another NOTIFY reaches nobody.
    await pool.query(`NOTIFY ${channel}`);
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(reloads, 1);
  });

  // The flake of this file in full runs: `stop()` returned before the LISTEN
  // session was gone, and the NOTIFY sent right after it still reached the
  // bus (about 4 in 100 on an idle machine, more under load).
  for (const own of [true, false]) {
    it(`a NOTIFY sent right after stop() never reloads (${own ? 'own' : 'pooled'} connection)`, async () => {
      let reloads = 0;
      for (let round = 0; round < 60; round += 1) {
        const bus = new ReloadBus({
          pool,
          ...(own ? { listenConnectionString: PG_URL! } : {}),
          channel,
          enableListen: true,
          reconcileIntervalMs: 0,
          reload: () => {
            reloads += 1;
            return Promise.resolve();
          },
        });
        await bus.start();
        await bus.stop();
        await pool.query(`NOTIFY ${channel}`);
      }
      await new Promise((done) => setTimeout(done, 150));
      assert.equal(reloads, 0);
    });
  }

  it('stop() leaves no LISTEN session behind, also when it comes while the bus connects', async () => {
    const listeners = async (): Promise<number> =>
      (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = $1 AND pid <> pg_backend_pid()`,
          [`LISTEN ${channel}`],
        )
      ).rows[0]!.n;
    const make = (): ReloadBus =>
      new ReloadBus({
        pool,
        listenConnectionString: PG_URL!,
        channel,
        enableListen: true,
        reconcileIntervalMs: 0,
        reload: () => Promise.resolve(),
      });
    const started = make();
    await started.start();
    assert.equal(await listeners(), 1);
    await started.stop();
    assert.equal(await listeners(), 0, 'gone when stop() returns, not some time later');

    const racing = make();
    const starting = racing.start().catch(() => undefined);
    await racing.stop();
    await starting;
    await until(() => false, 200);
    assert.equal(await listeners(), 0);
  });

  it('a reload that was running when stop() was called is awaited, and none follows it', async () => {
    let reloads = 0;
    let finish: () => void = () => undefined;
    const bus = new ReloadBus({
      pool,
      channel,
      reconcileIntervalMs: 0,
      reload: () => {
        reloads += 1;
        return new Promise<void>((done) => {
          finish = done;
        });
      },
    });
    await bus.start();
    void bus.triggerNow();
    void bus.triggerNow(); // queued behind the running one
    let stopped = false;
    const stopping = bus.stop().then(() => {
      stopped = true;
    });
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(stopped, false, 'stop waits for the running reload');
    finish();
    await stopping;
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(reloads, 1, 'the queued reload does not run after stop');
    await bus.triggerNow();
    assert.equal(reloads, 1);
  });

  it('without an address of its own it reserves one pooled connection, as before', async () => {
    let reloads = 0;
    const bus = new ReloadBus({
      pool,
      channel,
      enableListen: true,
      reconcileIntervalMs: 0,
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    await bus.start();
    try {
      assert.equal(pool.totalCount - pool.idleCount, 1);
      await pool.query(`NOTIFY ${channel}`);
      await until(() => reloads > 0);
      assert.equal(reloads, 1);
    } finally {
      await bus.stop();
    }
  });
});
