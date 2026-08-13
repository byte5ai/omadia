import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { DurableTaskStore } from '../../src/tasks/durableTaskStore.js';
import { runTaskStoreConformance } from './taskStoreConformance.js';

/**
 * Issue #560 — the DURABLE `TaskStore` driven against real Postgres.
 *
 * It runs the identical shared conformance suite the in-memory reference runs
 * (`taskStoreConformance.ts`), so the durable store is proven behaviourally
 * equal — plus a few durable-only checks (the FOR UPDATE SKIP LOCKED claim, and
 * that a row genuinely survives a fresh store instance, which is the whole point
 * over the in-memory store). Skips cleanly with a logged reason when no test
 * Postgres is configured (issue #572).
 */
const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'durableTaskStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'WS5_PG_TEST_URL', 'DATABASE_URL'],
});

if (pgAvailable && PG_URL) {
  const pool = new Pool({ connectionString: PG_URL });
  after(() => pool.end());
  await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);

  // Shared conformance — a fresh, truncated table per test.
  runTaskStoreConformance('durable (pg)', async () => {
    await pool.query('TRUNCATE tasks, task_events');
    return new DurableTaskStore(pool);
  });

  describe('durableTaskStore — durability + concurrency (pg)', () => {
    it('a task written by one store instance survives into a fresh instance', async () => {
      await pool.query('TRUNCATE tasks, task_events');
      const writer = new DurableTaskStore(pool);
      const created = await writer.create({ kind: 'k', input: { survives: true } });

      // A brand-new store object (the "after restart" stand-in) sees the row.
      const reader = new DurableTaskStore(pool);
      const got = await reader.get(created.id);
      assert.equal(got?.id, created.id);
      const claimed = await reader.claimNextPending(randomUUID());
      assert.deepEqual(claimed?.input, { survives: true });
    });

    it('two concurrent claims never hand back the same task (SKIP LOCKED)', async () => {
      await pool.query('TRUNCATE tasks, task_events');
      const store = new DurableTaskStore(pool);
      await store.create({ kind: 'k', input: { n: 1 } });

      const [a, b] = await Promise.all([
        store.claimNextPending(randomUUID()),
        store.claimNextPending(randomUUID()),
      ]);
      const claimedIds = [a, b].filter((c): c is NonNullable<typeof c> => c !== null);
      assert.equal(claimedIds.length, 1, 'exactly one claimer wins the single task');
    });
  });
} else {
  describe('durableTaskStore (pg)', { skip: true }, () => {
    it('skipped — no test Postgres configured (issue #572)', () => {});
  });
}
