import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { runConductorMigrations } from '../src/conductor/migrator.js';
import { ConductorAwaitStore } from '../src/conductor/awaitStore.js';
import { ConductorRunStore } from '../src/conductor/runStore.js';
import { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import { UNRESOLVED_PLACEHOLDER } from '../src/conductor/runInterpolation.js';

// #1709 — an await parked BEFORE the interpolation fix still holds raw `{{ctx.…}}`
// template text, and an await row is written once and never rewritten, so the
// operator inbox would show it forever. `ConductorAwaitStore` joins the run's
// context into every read and renders such a row on the way out.
//
// This file exists for the SQL: the aliased join (`conductor_awaits a LEFT JOIN
// conductor_runs r`) is exercised on a real Postgres through every read path, so a
// column ambiguity or a typo cannot hide behind a fake pool.

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'conductorAwaitMessageRender',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MARK = 'await-render-pg-test';

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

describe('ConductorAwaitStore — stored message rendering (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let awaitStore: ConductorAwaitStore;
  let runStore: ConductorRunStore;
  let workflowStore: ConductorWorkflowStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await migrateWithRetry(pool);
    awaitStore = new ConductorAwaitStore(pool);
    runStore = new ConductorRunStore(pool);
    workflowStore = new ConductorWorkflowStore(pool);
  });

  after(async () => {
    // conductor_runs does not cascade from conductor_workflow_versions — runs first
    // (conductor_awaits cascades from conductor_runs).
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

  /** A real workflow + published version + a `running` run carrying `context`. */
  async function newRun(context: Record<string, unknown>): Promise<string> {
    const slug = `${MARK}-${randomUUID().slice(0, 8)}`;
    const graph = { entryStepId: 's1', steps: [{ id: 's1', kind: 'action', actionId: 'noop' }], transitions: [] };
    const { version } = await workflowStore.createOrPublish({ slug, name: slug, graph: graph as never, enable: true });
    const run = await runStore.create({
      workflowVersionId: version.id,
      entryStepId: 's1',
      context: context as never,
      triggerKind: 'manual',
      claimedBy: randomUUID(),
    });
    return run.id;
  }

  /** Write the await the way a PRE-FIX kernel did: the template text, unrendered. */
  async function parkLegacyAwait(
    runId: string,
    message: string,
    opts?: { reminderIntervalMs?: number; deadlineAt?: Date; principalKind?: 'user' | 'role' | 'timer' },
  ): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conductor_awaits
         (run_id, step_id, principal_kind, principal_ref, channel_type, message, quorum,
          reminder_interval_ms, deadline_at, created_at, last_reminder_at)
       VALUES ($1, 's1', $2, 'role-hr', 'teams', $3, 'any', $4, $5, now() - interval '1 day', NULL)
       RETURNING id`,
      [
        runId,
        opts?.principalKind ?? 'role',
        message,
        opts?.reminderIntervalMs ?? null,
        opts?.deadlineAt ?? null,
      ],
    );
    return r.rows[0]!.id;
  }

  const TEMPLATE = 'New hire {{ctx.employeeName}} starts on {{ctx.startDate}}. Please confirm.';
  const RENDERED = 'New hire Ada Lovelace starts on 2026-12-01. Please confirm.';
  const CONTEXT = { employeeName: 'Ada Lovelace', startDate: '2026-12-01' };

  it('renders a legacy row through get() and listWaiting() — the operator inbox', async () => {
    const runId = await newRun(CONTEXT);
    const awaitId = await parkLegacyAwait(runId, TEMPLATE);

    const one = await awaitStore.get(awaitId);
    assert.equal(one?.message, RENDERED);

    const waiting = await awaitStore.listWaiting(500);
    const mine = waiting.find((a) => a.id === awaitId);
    assert.ok(mine, 'await missing from listWaiting');
    assert.equal(mine.message, RENDERED);
  });

  it('renders a legacy row through the worker reads — listRemindersDue() and listDue()', async () => {
    const runId = await newRun(CONTEXT);
    const reminderId = await parkLegacyAwait(runId, TEMPLATE, { reminderIntervalMs: 1 });
    const dueId = await parkLegacyAwait(
      await newRun(CONTEXT),
      TEMPLATE,
      { deadlineAt: new Date(Date.now() - 60_000) },
    );

    const reminders = await awaitStore.listRemindersDue(new Date());
    assert.equal(reminders.find((a) => a.id === reminderId)?.message, RENDERED);

    const due = await awaitStore.listDue(new Date());
    assert.equal(due.find((a) => a.id === dueId)?.message, RENDERED);
  });

  it('renders a legacy timer row through openTimerAwaitForRun()', async () => {
    const runId = await newRun(CONTEXT);
    await parkLegacyAwait(runId, TEMPLATE, { principalKind: 'timer' });

    const timer = await awaitStore.openTimerAwaitForRun(runId);
    assert.equal(timer?.message, RENDERED);
  });

  it('shows dashes, never raw syntax, when the run carries no value for the token', async () => {
    const runId = await newRun({});
    const awaitId = await parkLegacyAwait(runId, TEMPLATE);

    const aw = await awaitStore.get(awaitId);
    assert.ok(aw);
    assert.ok(!aw.message.includes('{{'), aw.message);
    assert.equal(
      aw.message,
      `New hire ${UNRESOLVED_PLACEHOLDER} starts on ${UNRESOLVED_PLACEHOLDER}. Please confirm.`,
    );
  });

  it('leaves a message written by the current kernel untouched', async () => {
    // `create()` is the only production writer and renders before inserting; its row has
    // no token left, so the read path must not touch it even when the context disagrees.
    const runId = await newRun({ employeeName: 'someone else' });
    const created = await awaitStore.create({
      runId,
      stepId: 's1',
      principalKind: 'role',
      principalRef: 'role-hr',
      channelType: 'teams',
      message: RENDERED,
      quorum: 'any',
      reminderIntervalMs: null,
      deadlineAt: null,
      fallbackTransitionId: null,
    });
    assert.equal(created.message, RENDERED);
    assert.equal((await awaitStore.get(created.id))?.message, RENDERED);
  });
});
