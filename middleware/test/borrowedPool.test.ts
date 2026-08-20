/**
 * Epic #470 C7 / G4 — the borrowed-pool lifecycle guard.
 *
 * `graphPool` is the operator's own `pg.Pool`, shared with core. These cases
 * pin that a plugin may USE it and may not END it — the #665 class of bug,
 * where a plugin's cleanup takes core's database down with it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient } from 'pg';

import {
  borrowPool,
  PoolLifecycleError,
} from '../src/platform/borrowedPool.js';

const PLUGIN = '@omadia/verifier';

/** A stand-in with the only surface these cases exercise. Deliberately not a
 *  real Pool: the guard must hold for the shape, not for one pg version. */
function fakePool(): {
  pool: Pool;
  ended: () => boolean;
  released: () => boolean;
} {
  let didEnd = false;
  let didRelease = false;
  const client = {
    query: () => Promise.resolve({ rows: [{ ok: 1 }] }),
    release: () => {
      didRelease = true;
    },
    // `pg` really does expose the owning pool here — that is the escape the
    // client wrapper exists to close.
    pool: undefined as unknown,
  };
  const pool = {
    query: () => Promise.resolve({ rows: [{ ok: 1 }] }),
    connect: () => Promise.resolve(client),
    end: () => {
      didEnd = true;
      return Promise.resolve();
    },
    removeAllListeners: () => undefined,
    totalCount: 3,
  };
  client.pool = pool;
  return {
    pool: pool as unknown as Pool,
    ended: () => didEnd,
    released: () => didRelease,
  };
}

describe('#470 C7 borrowPool', () => {
  it('lets a plugin QUERY — arbitrary SQL is the granted, intended behaviour', async () => {
    const { pool } = fakePool();
    const borrowed = borrowPool(pool, PLUGIN);
    const res = await borrowed.query('SELECT 1');
    assert.equal(res.rows.length, 1);
  });

  it('refuses end() and does NOT tear the real pool down', async () => {
    const { pool, ended } = fakePool();
    const borrowed = borrowPool(pool, PLUGIN);

    assert.throws(
      () => borrowed.end(),
      (err: unknown) => {
        assert.ok(err instanceof PoolLifecycleError);
        assert.equal(err.method, 'end');
        assert.match(err.message, /borrowed rather than owned/);
        return true;
      },
    );

    // The assertion that actually matters: the guard must PREVENT the effect,
    // not merely report it. A wrapper that threw after calling through would
    // pass a throws-check and still have killed core's pool.
    assert.equal(ended(), false, 'the underlying pool must not have ended');
  });

  it('refuses removeAllListeners — core owns the pool error handling', () => {
    const { pool } = fakePool();
    assert.throws(
      () => borrowPool(pool, PLUGIN).removeAllListeners(),
      PoolLifecycleError,
    );
  });

  it('allows connect() and release(), so a borrower can return connections', async () => {
    const { pool, released } = fakePool();
    const client = await borrowPool(pool, PLUGIN).connect();
    await client.query('SELECT 1');
    client.release();
    assert.equal(released(), true);
  });

  it('closes the client escape: connect().pool cannot reach end()', async () => {
    const { pool, ended } = fakePool();
    const client = (await borrowPool(pool, PLUGIN).connect()) as PoolClient & {
      pool: Pool;
    };

    assert.throws(
      () => client.pool,
      (err: unknown) => {
        assert.ok(err instanceof PoolLifecycleError);
        assert.match(err.method, /connect\(\)\.pool/);
        return true;
      },
    );
    assert.equal(ended(), false);
  });

  it('names the plugin in the error — an operator must know whose bug it is', () => {
    const { pool } = fakePool();
    assert.throws(
      () => borrowPool(pool, '@acme/rogue').end(),
      (err: unknown) => {
        assert.ok(err instanceof PoolLifecycleError);
        assert.equal(err.pluginId, '@acme/rogue');
        return true;
      },
    );
  });

  it('passes non-function properties through untouched', () => {
    const { pool } = fakePool();
    assert.equal(borrowPool(pool, PLUGIN).totalCount, 3);
  });
});
