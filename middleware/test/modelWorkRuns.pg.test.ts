/**
 * Spec 2042 §5.10 — operator jobs and maintenance runs against a real
 * Postgres (migration 0089 `model_work_runs`): a run is recorded with its
 * effects, budget and outcome, the daily budget is summed from the rows, and
 * a run that died while running stops holding its budget at its deadline.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { admitModelCall } from '@omadia/llm-provider';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';
import { ModelWorkBudgetError, createModelWorkRuns, type ModelWorkKind } from '../src/platform/modelWorkRuns.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'modelWorkRuns',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `model_work_runs_${String(process.pid)}`;

const job = (budgetCalls: number, deadlineMs = 60_000): ModelWorkKind => ({
  kind: 'topic_regrouping',
  context: 'operator_job',
  budgetCalls,
  deadlineMs,
  effects: ['topics', 'memory_significance'],
});

describe('model work runs (pg, migration 0089)', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${SCHEMA},public` });
    const sql = await readFile(resolve(MIGRATIONS_DIR, '0089_model_work_runs.sql'), 'utf8');
    // The CI schema job applies every migration twice.
    await pool.query(sql);
    await pool.query(sql);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  it('records a run with its effects, budget, calls and outcome', async () => {
    const runs = createModelWorkRuns({ pool, operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    await runs.run(job(5), 'op@example.com', async () => {
      admitModelCall();
      admitModelCall();
    });
    const [row] = await runs.list(1);
    assert.equal(row?.status, 'succeeded');
    assert.equal(row?.modelCalls, 2);
    assert.equal(row?.budgetCalls, 5);
    assert.deepEqual(row?.effects, ['topics', 'memory_significance']);
    assert.equal(row?.startedBy, 'op@example.com');
    assert.ok(row?.endedAt);
  });

  it('sums the daily budget from the rows, a running run at its whole budget', async () => {
    await pool.query('TRUNCATE model_work_runs');
    const runs = createModelWorkRuns({ pool, operatorDailyCalls: 10, maintenanceDailyCalls: 100 });
    let release: () => void = () => undefined;
    const holding = runs.run(job(8), 'op', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    // 8 held, 2 left: a job of budget 5 starts with 2 and is stopped at its third call.
    await assert.rejects(
      runs.run(job(5), 'op', async () => {
        admitModelCall();
        admitModelCall();
        admitModelCall();
      }),
    );
    release();
    await holding;
    // The holding run used nothing, the second used 2: 8 are left.
    await runs.run(job(8), 'op', async () => undefined);
  });

  it('a run that died while running counts what it recorded once past its deadline', async () => {
    await pool.query('TRUNCATE model_work_runs');
    await pool.query(
      `INSERT INTO model_work_runs (id, context_kind, job_kind, budget_calls, started_at, deadline_at)
       VALUES (gen_random_uuid(), 'operator_job', 'topic_regrouping', 10, now() - interval '2 hours', now() - interval '1 hour')`,
    );
    const runs = createModelWorkRuns({ pool, operatorDailyCalls: 10, maintenanceDailyCalls: 100 });
    assert.equal(await runs.run(job(5), 'op', async () => 'ran'), 'ran');
    await pool.query(
      `INSERT INTO model_work_runs (id, context_kind, job_kind, budget_calls, started_at, deadline_at)
       VALUES (gen_random_uuid(), 'operator_job', 'topic_regrouping', 10, now(), now() + interval '1 hour')`,
    );
    await assert.rejects(runs.run(job(5), 'op', async () => 'ran'), ModelWorkBudgetError);
  });
});
