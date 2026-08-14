import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  createUpdateAuditStore,
  resetAuditTableCacheForTests,
} from '../src/update/auditStore.js';

/**
 * #432 — the self-update audit trail against a real Postgres.
 *
 * A fake pool cannot exercise what actually matters here: the lazy
 * `CREATE TABLE IF NOT EXISTS`, the `gen_random_uuid()` default (which needs
 * pgcrypto/pg13+), and above all `reconcileOpenEntries`, whose whole job is a
 * time-windowed UPDATE — `make_interval(secs => …)` against `now()` is real SQL
 * that a hand-rolled fake would only ever pretend to run.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'updateAuditStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

describe('update_audit (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ReturnType<typeof createUpdateAuditStore>;

  before(() => {
    pool = new Pool({ connectionString: PG_URL });
    store = createUpdateAuditStore(pool);
  });

  after(async () => {
    await pool.query('DROP TABLE IF EXISTS update_audit');
    await pool.end();
  });

  beforeEach(async () => {
    resetAuditTableCacheForTests();
    await pool.query('DROP TABLE IF EXISTS update_audit');
  });

  it('creates its table on first use and records the request', async () => {
    const entry = await store.recordRequest({
      actor: 'operator@example.com',
      fromVersion: 'v0.74.0',
      toVersion: 'v0.75.0',
    });

    assert.match(entry.id, /^[0-9a-f-]{36}$/);
    assert.equal(entry.actor, 'operator@example.com');
    assert.equal(entry.outcome, 'requested');
    assert.equal(entry.detail, null);
    assert.ok(Date.parse(entry.createdAt) > 0);
  });

  it('is idempotent across stores sharing the pool', async () => {
    await store.recordRequest({
      actor: 'a',
      fromVersion: 'v1.0.0',
      toVersion: 'v1.1.0',
    });
    resetAuditTableCacheForTests();
    const second = createUpdateAuditStore(pool);
    await second.recordRequest({
      actor: 'b',
      fromVersion: 'v1.1.0',
      toVersion: 'v1.2.0',
    });

    assert.equal((await store.list()).length, 2);
  });

  it('lists newest first', async () => {
    for (const to of ['v1.1.0', 'v1.2.0', 'v1.3.0']) {
      await store.recordRequest({ actor: 'a', fromVersion: 'v1.0.0', toVersion: to });
      // created_at defaults to now(); the same statement timestamp inside one
      // transaction would tie, so space them by a millisecond.
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.deepEqual(
      (await store.list()).map((e) => e.toVersion),
      ['v1.3.0', 'v1.2.0', 'v1.1.0'],
    );
  });

  it('settles a request as succeeded once that version is observed running', async () => {
    await store.recordRequest({
      actor: 'a',
      fromVersion: 'v0.74.0',
      toVersion: 'v0.75.0',
    });

    await store.reconcileOpenEntries('v0.75.0');

    const [entry] = await store.list();
    assert.equal(entry?.outcome, 'succeeded');
    assert.match(entry?.detail ?? '', /observed running/);
  });

  it('leaves a fresh request open while a different version is running', async () => {
    // The middleware answers again seconds after the trigger — possibly still
    // the OLD container, because the recreate has not landed yet. Marking that
    // failed immediately would report every successful update as a failure.
    await store.recordRequest({
      actor: 'a',
      fromVersion: 'v0.74.0',
      toVersion: 'v0.75.0',
    });

    await store.reconcileOpenEntries('v0.74.0');

    assert.equal((await store.list())[0]?.outcome, 'requested');
  });

  it('settles a stale request as failed once the window has passed', async () => {
    await store.recordRequest({
      actor: 'a',
      fromVersion: 'v0.74.0',
      toVersion: 'v0.75.0',
    });

    // Zero-length staleness window: everything already written is past it.
    await store.reconcileOpenEntries('v0.74.0', 0);

    const [entry] = await store.list();
    assert.equal(entry?.outcome, 'failed');
    assert.match(entry?.detail ?? '', /never observed running/);
  });

  it('does not re-settle an already terminal row', async () => {
    await store.recordRequest({
      actor: 'a',
      fromVersion: 'v0.74.0',
      toVersion: 'v0.75.0',
    });
    await store.reconcileOpenEntries('v0.75.0');
    await store.reconcileOpenEntries('v0.74.0', 0);

    assert.equal((await store.list())[0]?.outcome, 'succeeded');
  });

  it('caps the page size rather than trusting the caller', async () => {
    await store.recordRequest({ actor: 'a', fromVersion: 'v1.0.0', toVersion: 'v1.1.0' });
    assert.equal((await store.list(0)).length, 1);
    assert.equal((await store.list(10_000)).length, 1);
  });
});
