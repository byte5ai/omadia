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
import { SqlTableRefusedError } from '../src/platform/sqlTableGuard.js';

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

describe('ADR-0255 borrowPool with the table guard', () => {
  const UPLOAD = '@acme/tool';
  const guarded = (pool: Pool): Pool => borrowPool(pool, UPLOAD, { guardStatements: true });

  it('runs the plugin’s own statements, pool and client', async () => {
    const { pool } = fakePool();
    const borrowed = guarded(pool);
    assert.equal((await borrowed.query('SELECT * FROM acme_items')).rows.length, 1);
    const client = await borrowed.connect();
    assert.equal((await client.query({ text: 'UPDATE acme_items SET n = $1', values: [1] })).rows.length, 1);
  });

  it('refuses a kernel table on the pool and on a client, before the statement runs', async () => {
    let ran = 0;
    const { pool } = fakePool();
    const counting = Object.assign(pool, { query: () => { ran += 1; return Promise.resolve({ rows: [] }); } });
    const borrowed = guarded(counting as unknown as Pool);
    await assert.rejects(() => borrowed.query('SELECT * FROM graph_nodes'), SqlTableRefusedError);
    const client = await borrowed.connect();
    await assert.rejects(() => client.query('SELECT * FROM memory_files'), SqlTableRefusedError);
    assert.equal(ran, 0);
  });

  it('answers a callback-style query through the callback', async () => {
    const { pool } = fakePool();
    const err = await new Promise<unknown>((resolve) => {
      (guarded(pool).query as unknown as (sql: string, cb: (e: unknown) => void) => void)('SELECT * FROM users', resolve);
    });
    assert.ok(err instanceof SqlTableRefusedError);
  });

  it('hides the listeners, the connection options and the internals', async () => {
    const { pool } = fakePool();
    Object.assign(pool, { on: () => pool, options: { password: 'secret' }, _clients: [], Client: class {} });
    const borrowed = guarded(pool) as unknown as Record<string, unknown>;
    for (const member of ['on', 'once', 'addListener', 'options', '_clients', 'Client']) {
      assert.throws(() => borrowed[member], PoolLifecycleError, member);
    }
    const client = (await guarded(pool).connect()) as unknown as Record<string, unknown>;
    for (const member of ['connection', 'connectionParameters', 'password', '_queryable']) {
      assert.throws(() => client[member], PoolLifecycleError, member);
    }
  });

  it('hides the same members from reflection and refuses writes', async () => {
    const { pool } = fakePool();
    Object.assign(pool, { options: { password: 'secret' }, _clients: [] });
    const borrowed = guarded(pool);
    assert.equal(Object.getOwnPropertyDescriptor(borrowed, 'options'), undefined);
    assert.equal(Object.getOwnPropertyDescriptor(borrowed, '_clients'), undefined);
    assert.equal('options' in borrowed, false);
    assert.ok(!Reflect.ownKeys(borrowed).includes('options'));
    assert.throws(() => Object.assign(borrowed, { query: () => undefined }), PoolLifecycleError);
    assert.throws(() => (borrowed as unknown as { constructor: unknown }).constructor, PoolLifecycleError);
    const client = await borrowed.connect();
    Object.assign(client, {});
    assert.throws(() => (client as unknown as { on: unknown }).on, PoolLifecycleError);
  });

  it('passes the checked copy to pg, not the plugin’s object', async () => {
    const seen: unknown[] = [];
    const { pool } = fakePool();
    Object.assign(pool, { query: (arg: unknown) => { seen.push(arg); return Promise.resolve({ rows: [] }); } });
    let reads = 0;
    const tricky = { get text(): string { reads += 1; return reads <= 1 ? 'SELECT 1' : 'SELECT * FROM users'; } };
    await guarded(pool).query(tricky as never);
    assert.deepEqual((seen[0] as { text: string }).text, 'SELECT 1');
    await assert.rejects(
      () => guarded(pool).query({ text: 'SELECT 1', submit: () => undefined } as never),
      SqlTableRefusedError,
    );
  });

  it('leaves an unguarded (bundled) borrower as before', async () => {
    const { pool } = fakePool();
    assert.equal((await borrowPool(pool, PLUGIN).query('SELECT * FROM graph_nodes')).rows.length, 1);
  });
});

