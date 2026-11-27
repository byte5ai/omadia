/**
 * #2316 (ADR-0279) — `RoutineStore.recentDeliveriesForScope` against a real
 * Postgres with the routine migration series (incl. 0013 origin_scope).
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { runRoutineMigrations } from '../src/plugins/routines/migrator.js';
import { RoutineStore } from '../src/plugins/routines/routineStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'routineOriginScopeDeliveries',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});
const SCHEMA = `routine_origin_${String(process.pid)}`;

describe('RoutineStore.recentDeliveriesForScope (pg, #2316)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: RoutineStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    await runRoutineMigrations(pool);
    await runRoutineMigrations(pool);
    store = new RoutineStore({ pool, log: () => undefined });
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('returns delivered runs of routines created in the scope, newest first, within the window', async () => {
    const base = { tenant: 't', cron: '0 9 * * *', prompt: 'p', channel: 'teams', conversationRef: { id: 'c' } };
    const here = await store.create({ ...base, userId: 'u1', name: 'Here', agentSlug: 'erika', originScope: 'teams-19:abc' });
    const otherAgent = await store.create({ ...base, userId: 'u1', name: 'Other agent', agentSlug: 'max', originScope: 'teams-19:abc' });
    const elsewhere = await store.create({ ...base, userId: 'u1', name: 'Elsewhere', agentSlug: 'erika', originScope: 'teams-19:other' });
    const insert = (routineId: string, status: string, answer: string | null, ageMin: number): Promise<unknown> =>
      pool.query(
        `INSERT INTO routine_runs (routine_id, tenant, user_id, status, prompt, answer, started_at, finished_at)
         VALUES ($1, 't', 'u1', $2, 'p', $3, now() - ($4 || ' minutes')::interval, now() - ($4 || ' minutes')::interval)`,
        [routineId, status, answer, String(ageMin)],
      );
    await insert(here.id, 'ok', 'old report', 60 * 30);
    await insert(here.id, 'ok', 'report one', 120);
    await insert(here.id, 'error', 'failed', 60);
    await insert(here.id, 'ok', 'report two', 10);
    await insert(elsewhere.id, 'ok', 'other chat', 5);
    await insert(otherAgent.id, 'ok', 'max report', 5);
    const rows = await store.recentDeliveriesForScope('teams-19:abc', 'erika', new Date(Date.now() - 24 * 3_600_000), 3);
    assert.deepEqual(rows.map((r) => r.content), ['report two', 'report one']);
    assert.equal(rows[0]?.routineName, 'Here');
  });
});
