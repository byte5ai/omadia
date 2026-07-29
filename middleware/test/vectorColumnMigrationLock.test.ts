import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { migrateVectorColumns } from '@omadia/knowledge-graph-neon/dist/vectorColumnMigration.js';

/**
 * #440 follow-up (F3) — the SESSION advisory lock must never go back to the
 * pool with the connection that may still hold it.
 *
 * A real Postgres proves the lock ends up free (see
 * `embeddingModelGateMigrationGuards.pg.test.ts`), but it cannot force the
 * interesting case: an unlock that FAILS. That is the one that matters,
 * because it is the only situation where the lock is still held on the way
 * out, and `pg_advisory_unlock` fails exactly when the connection is in an
 * aborted transaction or broken — precisely the states a real failure leaves
 * behind. A fake driver is the only way to pin the mechanism itself:
 * `release(true)` (destroy) versus `release(false)` (pool).
 *
 * Why it matters more than a usual leak: `decideRegistry` takes a BLOCKING
 * `pg_advisory_xact_lock` in this same namespace with NO `lock_timeout`, so a
 * leaked lock does not degrade the knowledge-graph plugin — it hangs its
 * activation until the process restarts.
 */

const silent = (): void => undefined;

interface LockFakeScript {
  /** Make `readRegistryRow` throw — a failure inside the locked region that
   *  is NOT the `migrateOneColumn` path the old code special-cased. */
  registryReadThrows?: boolean;
  /** Make `pg_advisory_unlock` throw, the way it does on a connection stuck
   *  inside an aborted transaction. */
  unlockThrows?: boolean;
  /** Driver answers `pg_advisory_unlock` with FALSE — it did not hold it. */
  unlockReportsNotHeld?: boolean;
}

function makeLockPool(script: LockFakeScript = {}): {
  pool: Pool;
  releases: boolean[];
} {
  const releases: boolean[] = [];

  const rows = (r: ReadonlyArray<Record<string, unknown>>): QueryResult =>
    ({ command: '', rowCount: r.length, oid: 0, rows: [...r], fields: [] }) as unknown as QueryResult;

  const query = async (sql: string): Promise<QueryResult> => {
    if (/pg_try_advisory_lock/i.test(sql)) return rows([{ locked: true }]);
    if (/pg_advisory_unlock/i.test(sql)) {
      if (script.unlockThrows === true) {
        throw new Error('current transaction is aborted, commands ignored');
      }
      return rows([{ unlocked: script.unlockReportsNotHeld !== true }]);
    }
    if (/FROM graph_embedding_model/i.test(sql)) {
      if (script.registryReadThrows === true) {
        throw new Error('relation "graph_embedding_model" does not exist');
      }
      return rows([]);
    }
    // No governed column found → the migration loop is a no-op.
    if (/FROM pg_attribute/i.test(sql)) return rows([]);
    if (/INSERT INTO graph_embedding_model/i.test(sql)) {
      return rows([{ model_id: 'openai:text-embedding-3-small' }]);
    }
    return rows([]);
  };

  const pool = {
    async connect(): Promise<PoolClient> {
      return {
        query,
        release(destroy?: boolean): void {
          releases.push(destroy === true);
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;

  return { pool, releases };
}

const baseOpts = {
  tenantId: 't1',
  targets: [{ table: 'graph_nodes', column: 'embedding' }],
  targetModelId: 'openai:text-embedding-3-small',
  targetDimensions: 1536,
  switchCooldownMs: 0,
  log: silent,
};

describe('#440 F3 — the registry advisory lock is never pooled while held', () => {
  it('destroys the connection when the unlock fails after a throw in the locked region', async () => {
    const { pool, releases } = makeLockPool({
      registryReadThrows: true,
      unlockThrows: true,
    });

    await assert.rejects(
      migrateVectorColumns({ pool, ...baseOpts }),
      /graph_embedding_model/,
    );

    // `poisoned` used to be set ONLY on the `migrateOneColumn` failure path,
    // so this throw ran the finally, swallowed the unlock's failure and handed
    // a connection that still holds a SESSION-scoped lock back to the pool.
    assert.deepEqual(
      releases,
      [true],
      'release(true) DESTROYS the connection, which is the only other way the session lock goes',
    );
  });

  it('destroys the connection when the unlock fails on the SUCCESS path', async () => {
    // Nothing threw, everything committed — and the unlock still failed. The
    // lock is held by a connection about to be reused; pooling it is the same
    // hang as above.
    const { pool, releases } = makeLockPool({ unlockThrows: true });
    const result = await migrateVectorColumns({ pool, ...baseOpts });
    assert.equal(result.ok, true);
    assert.deepEqual(releases, [true]);
  });

  it('destroys the connection when the driver says the lock was not released', async () => {
    const { pool, releases } = makeLockPool({ unlockReportsNotHeld: true });
    await migrateVectorColumns({ pool, ...baseOpts });
    assert.deepEqual(releases, [true]);
  });

  it('pools the connection when the unlock provably succeeded', async () => {
    // The common case must not pay for the guard: a clean run returns its
    // connection to the pool exactly as before.
    const { pool, releases } = makeLockPool();
    const result = await migrateVectorColumns({ pool, ...baseOpts });
    assert.equal(result.ok, true);
    assert.deepEqual(releases, [false]);
  });

  it('pools the connection when a throw happened but the unlock succeeded', async () => {
    const { pool, releases } = makeLockPool({ registryReadThrows: true });
    await assert.rejects(migrateVectorColumns({ pool, ...baseOpts }));
    assert.deepEqual(
      releases,
      [false],
      'a healthy connection whose lock provably went must not be thrown away',
    );
  });
});
