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
