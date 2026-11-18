import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { runConductorMigrations } from '../src/conductor/migrator.js';
import { ConductorRunStore } from '../src/conductor/runStore.js';
import { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import { runError } from '../src/conductor/runError.js';

// #1699 — the cause of a failure must be READ BACK out of the tables, not merely
// handed to the recorder. The executor's classification per failure path is
// pinned in conductorRunFailureCause.test.ts against a fake store; this file runs
// the real `ConductorRunStore` against a real Postgres and asserts what migration
// 0013's columns actually hold afterwards — including the per-step duration, which
// was structurally zero for every row before it.

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'conductorRunError',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MARK = 'runerror-pg-test';

/** See conductorWebhookSubscriptionStore.pg.test.ts — the first concurrent apply
 *  against a fresh database can lose a 23505 race on the migration ledger. */
async function migrateWithRetry(pool: Pool): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runConductorMigrations(pool);
      return;
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code !== '23505' || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

describe('ConductorRunStore — stored failure cause (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let runStore: ConductorRunStore;
  let workflowStore: ConductorWorkflowStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await migrateWithRetry(pool);
    runStore = new ConductorRunStore(pool);
    workflowStore = new ConductorWorkflowStore(pool);
  });

  after(async () => {
    // conductor_runs does not cascade from conductor_workflow_versions — runs first.
    await pool.query(
      `DELETE FROM conductor_runs WHERE workflow_version_id IN (
         SELECT v.id FROM conductor_workflow_versions v
           JOIN conductor_workflows w ON w.id = v.workflow_id
          WHERE w.slug LIKE $1
       )`,
      [`${MARK}%`],
    );
    await pool.query(`DELETE FROM conductor_workflows WHERE slug LIKE $1`, [`${MARK}%`]);
    await pool.end();
  });

  /** A real workflow + published version + a `running` run owned by the returned lease. */
  async function newRun(): Promise<{ runId: string; claimedBy: string }> {
    const slug = `${MARK}-${randomUUID().slice(0, 8)}`;
    const graph = { entryStepId: 's1', steps: [{ id: 's1', kind: 'action', actionId: 'noop' }], transitions: [] };
    const { version } = await workflowStore.createOrPublish({ slug, name: slug, graph: graph as never, enable: true });
    const claimedBy = randomUUID();
    const run = await runStore.create({
      workflowVersionId: version.id,
      entryStepId: 's1',
      context: {},
      triggerKind: 'manual',
      claimedBy,
    });
    return { runId: run.id, claimedBy };
  }

  async function stepRow(runId: string, seq: number) {
    const r = await pool.query<{
      error_code: string | null;
      error_message: string | null;
      error_detail: unknown;
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT error_code, error_message, error_detail, started_at, ended_at
         FROM conductor_run_steps WHERE run_id = $1 AND seq = $2`,
      [runId, seq],
    );
    assert.ok(r.rows[0], `no step row at seq ${String(seq)}`);
    return r.rows[0];
  }

  async function runRow(runId: string) {
    const r = await pool.query<{ status: string; error_code: string | null; error_message: string | null }>(
      `SELECT status, error_code, error_message FROM conductor_runs WHERE id = $1`,
      [runId],
    );
    assert.ok(r.rows[0]);
    return r.rows[0];
  }

  it('stores a terminal cause on the step row AND mirrors it onto the run', async () => {
    const { runId, claimedBy } = await newRun();
    await runStore.recordStepAndAdvance({
      runId,
      seq: 0,
      stepId: 's1',
      actor: { kind: 'agent', ref: 'fallback' },
      postconditionOutcome: 'n/a',
      transitionTaken: null,
      nextStepId: null,
      context: {},
      status: 'failed',
      claimedBy,
      error: runError('effect_threw', 'Error: 429 Rate limit exceeded', { stepKind: 'agent', ref: 'fallback' }),
    });

    const step = await stepRow(runId, 0);
    assert.equal(step.error_code, 'effect_threw');
    assert.equal(step.error_message, 'Error: 429 Rate limit exceeded');
    assert.deepEqual(step.error_detail, { stepKind: 'agent', ref: 'fallback' });

    const run = await runRow(runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_code, 'effect_threw');
    assert.equal(run.error_message, 'Error: 429 Rate limit exceeded');

    // …and the mappers hand the same thing to the API (route serialises these objects).
    const steps = await runStore.stepsForRun(runId);
    assert.equal(steps[0]?.errorCode, 'effect_threw');
    assert.deepEqual(steps[0]?.errorDetail, { stepKind: 'agent', ref: 'fallback' });
    const mapped = await runStore.get(runId);
    assert.equal(mapped?.errorCode, 'effect_threw');
    assert.equal(mapped?.errorMessage, 'Error: 429 Rate limit exceeded');
  });

  it('keeps a recovered step\'s cause on the step only — the run is not stamped failed', async () => {
    const { runId, claimedBy } = await newRun();
    // A human step skipped for want of a holder, taking its in-graph fallback.
    await runStore.recordStepAndAdvance({
      runId,
      seq: 0,
      stepId: 's1',
      actor: { kind: 'human', noHolder: true },
      postconditionOutcome: 'unmet',
      transitionTaken: 't-skip',
      nextStepId: 's1',
      context: {},
      status: 'running',
      claimedBy,
      error: runError('no_role_holder', "human step 's1' has no reachable holder for role 'reviewer'"),
    });

    assert.equal((await stepRow(runId, 0)).error_code, 'no_role_holder');
    let run = await runRow(runId);
    assert.equal(run.status, 'running');
    assert.equal(run.error_code, null, 'a mid-run cause must not stamp the run');

    // The run then completes normally: it must not inherit the earlier cause.
    await runStore.recordStepAndAdvance({
      runId,
      seq: 1,
      stepId: 's1',
      actor: null,
      postconditionOutcome: 'met',
      transitionTaken: null,
      nextStepId: null,
      context: {},
      status: 'completed',
      claimedBy,
    });
    run = await runRow(runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.error_code, null);
    assert.equal(run.error_message, null);
    // The step row still remembers that a human was skipped.
    assert.equal((await stepRow(runId, 0)).error_code, 'no_role_holder');
  });

  it('reads an unrecognised stored code as "cause not recorded", keeping the message', async () => {
    const { runId, claimedBy } = await newRun();
    await runStore.recordStepAndAdvance({
      runId, seq: 0, stepId: 's1', actor: null, postconditionOutcome: 'n/a',
      transitionTaken: null, nextStepId: null, context: {}, status: 'failed', claimedBy,
      error: runError('effect_threw', 'boom'),
    });
    // Simulates a row written by a newer middleware (or by hand).
    await pool.query(`UPDATE conductor_run_steps SET error_code = 'from_the_future' WHERE run_id = $1`, [runId]);
    await pool.query(`UPDATE conductor_runs SET error_code = 'from_the_future' WHERE id = $1`, [runId]);

    const steps = await runStore.stepsForRun(runId);
    assert.equal(steps[0]?.errorCode, null);
    assert.equal(steps[0]?.errorMessage, 'boom');
    assert.equal((await runStore.get(runId))?.errorCode, null);
  });

  it('records a real step duration when the caller passes the step start', async () => {
    const { runId, claimedBy } = await newRun();
    const startedAt = new Date(Date.now() - 1_500);
    await runStore.recordStepAndAdvance({
      runId, seq: 0, stepId: 's1', actor: null, postconditionOutcome: 'met',
      transitionTaken: null, nextStepId: null, context: {}, status: 'completed', claimedBy,
      startedAt,
    });

    const step = await stepRow(runId, 0);
    assert.ok(step.ended_at, 'terminal step has an ended_at');
    const ms = step.ended_at.getTime() - step.started_at.getTime();
    assert.ok(ms >= 1_400, `expected the real duration, got ${String(ms)}ms`);
    // The stored start is the one the caller passed, not transaction time.
    assert.ok(Math.abs(step.started_at.getTime() - startedAt.getTime()) < 50);
  });

  it('falls back to transaction time when no start is passed (pre-0013 behaviour)', async () => {
    const { runId, claimedBy } = await newRun();
    await runStore.recordStepAndAdvance({
      runId, seq: 0, stepId: 's1', actor: null, postconditionOutcome: 'met',
      transitionTaken: null, nextStepId: null, context: {}, status: 'completed', claimedBy,
    });
    const step = await stepRow(runId, 0);
    // Exactly what every row carried before: both columns from the same now().
    assert.equal(step.started_at.getTime(), step.ended_at?.getTime());
  });

  it('leaves both error columns NULL for an operator cancel — a cancel is not a fault', async () => {
    const { runId, claimedBy } = await newRun();
    await runStore.recordStepAndAdvance({
      runId, seq: 0, stepId: 's1', actor: { kind: 'operator_cancel' }, postconditionOutcome: 'n/a',
      transitionTaken: null, nextStepId: null, context: {}, status: 'cancelled', claimedBy,
    });
    const run = await runRow(runId);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error_code, null);
    assert.equal((await stepRow(runId, 0)).error_code, null);
  });
});
