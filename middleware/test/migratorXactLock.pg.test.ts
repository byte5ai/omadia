/**
 * The migration lock against a real Postgres.
 *
 * The lock is transaction-scoped so that it works behind a transaction-mode
 * connection pooler (see `migratorConcurrentBoot.test.ts`). A real server
 * shows the two things a fake cannot: two replicas booting together both end
 * with a complete schema and no error, and nothing is left held afterwards.
 * (A pooler itself is not part of this test: the property that makes the
 * lock safe behind one is that no statement outside a transaction takes or
 * releases it, which the fake-driver suite pins.)
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  MULTI_ORCH_MIGRATION_LOCK_WAIT_MS,
  runMultiOrchestratorMigrations,
} from '../packages/harness-orchestrator/src/registry/migrator.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'migratorXactLock',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_NS = 4_410;
const LOCK_KEY = '_multi_orchestrator_migrations';

describe('migration lock (pg, transaction-scoped)', { skip: !pgAvailable }, () => {
  const schemas: string[] = [];
  const pools: Pool[] = [];
  let admin: Pool;

  const freshSchema = async (name: string): Promise<Pool> => {
    const schema = `${name}_${String(process.pid)}`;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    const pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema},public` });
    pools.push(pool);
    return pool;
  };
  const advisoryLocksHeld = async (): Promise<number> =>
    Number(
      (
        await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1`,
          [LOCK_NS],
        )
      ).rows[0]!.n,
    );

  before(async () => {
    admin = new Pool({ connectionString: PG_URL, max: 2 });
  });

  after(async () => {
    for (const pool of pools) await pool.end();
    for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('two replicas booting together both finish, every file is recorded once, nothing stays locked', async () => {
    const pool = await freshSchema('mig_xact_race');
    const logs: string[] = [];
    await Promise.all([
      runMultiOrchestratorMigrations(pool, (m) => logs.push(`a ${m}`), MIGRATIONS_DIR),
      runMultiOrchestratorMigrations(pool, (m) => logs.push(`b ${m}`), MIGRATIONS_DIR),
    ]);
    const ledger = await pool.query<{ id: string }>('SELECT id FROM _multi_orchestrator_migrations ORDER BY id');
    const applied = logs.filter((l) => /applying migration/.test(l)).map((l) => l.replace(/^. .*applying migration /, ''));
    assert.equal(ledger.rows.length > 60, true, 'the whole directory was applied');
    assert.deepEqual([...applied].sort(), ledger.rows.map((r) => r.id), 'each file was applied by exactly one of the two');
    assert.equal(await advisoryLocksHeld(), 0, 'no advisory lock outlives the run');
    // A third boot has nothing to do and takes no lock.
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
  });

  it('a replica that cannot get the lock gives up after its budget with a retryable error, and holds nothing', async () => {
    const pool = await freshSchema('mig_xact_wait');
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)', [LOCK_NS, LOCK_KEY]);
      const started = Date.now();
      await assert.rejects(
        runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR),
        /timed out after 2000ms waiting for the _multi_orchestrator_migrations advisory lock; \d+ migration\(s\) still pending/,
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= MULTI_ORCH_MIGRATION_LOCK_WAIT_MS - 200, `gave up after ${String(elapsed)}ms`);
      assert.ok(elapsed < MULTI_ORCH_MIGRATION_LOCK_WAIT_MS + 3_000, `overran: ${String(elapsed)}ms`);
      assert.equal(await advisoryLocksHeld(), 1, 'only the holder holds the lock');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    assert.equal(await advisoryLocksHeld(), 0);
    // With the lock free the same replica succeeds.
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    const count = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM _multi_orchestrator_migrations');
    assert.ok(Number(count.rows[0]!.n) > 60);
  });
});
