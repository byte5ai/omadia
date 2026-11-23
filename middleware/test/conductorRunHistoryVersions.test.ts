import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { ACTIVE_RUN_STATUSES, ACTIVE_RUN_STATUS_SQL, ConductorRunStore } from '../src/conductor/runStore.js';
import type { ConductorRunListEntry } from '../src/conductor/runStore.js';
import { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';
import type { ConductorWorkflow } from '../src/conductor/workflowStore.js';

// The run routes refuse an id that is not uuid-shaped (#1706), so the cancel step needs a real one.
const RUN_OLD_ID = '3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f';

// #1710 — the operator run history spans every version of a workflow. It used to
// be filtered to the ACTIVE version, so re-publishing a workflow emptied it —
// including for a run still WAITING on an older version, whose cancel button
// lives in exactly that list while DELETE /:slug keeps refusing the workflow
// with `conductor.has_active_runs`. The store tests pin the SQL shape (no DB),
// the route tests run the real router over a stubbed store — including the whole
// escape out of the dead end: list → cancel → delete.

// ---------------------------------------------------------------------------
// Store: listForWorkflow SQL shape
// ---------------------------------------------------------------------------

function fakePool(rows: unknown[]): { pool: Pool; issued: Array<{ sql: string; params: unknown[] }> } {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
      issued.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  return { pool, issued };
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    workflow_version_id: 'ver-1',
    status: 'waiting',
    current_step_id: 'approve',
    context: {},
    trigger_kind: 'manual',
    trigger_source: null,
    is_dry_run: false,
    started_at: new Date('2026-11-01T10:00:00.000Z'),
    ended_at: null,
    cancel_requested_by: null,
    cancel_requested_at: null,
    error_code: null,
    error_message: null,
    workflow_version: 1,
    ...overrides,
  };
}

describe('ConductorRunStore.listForWorkflow', () => {
  it('joins the versions table and scopes by workflow, not by version', async () => {
    const { pool, issued } = fakePool([]);
    await new ConductorRunStore(pool).listForWorkflow('wf-1');
    assert.equal(issued.length, 1);
    const s = issued[0]!.sql;
    assert.ok(s.includes('JOIN conductor_workflow_versions v ON v.id = r.workflow_version_id'), s);
    assert.ok(s.includes('WHERE v.workflow_id = $1'), s);
    assert.ok(!s.includes('r.workflow_version_id = $1'), 'must not be filtered to a single version');
    assert.deepEqual(issued[0]!.params, ['wf-1', 50]);
  });

  it('selects the version NUMBER and returns it on every row', async () => {
    const { pool, issued } = fakePool([
      runRow({ id: 'run-v1', workflow_version: 1 }),
      runRow({ id: 'run-v2', workflow_version: 2, status: 'completed' }),
    ]);
    const runs = await new ConductorRunStore(pool).listForWorkflow('wf-1');
    assert.ok(issued[0]!.sql.includes('v.version AS workflow_version'), issued[0]!.sql);
    assert.deepEqual(
      runs.map((r: ConductorRunListEntry) => [r.id, r.workflowVersion]),
      [
        ['run-v1', 1],
        ['run-v2', 2],
      ],
    );
  });

  it('coerces a string-typed version column to a number (pg type parsing is configurable)', async () => {
    const { pool } = fakePool([runRow({ workflow_version: '7' })]);
    const runs = await new ConductorRunStore(pool).listForWorkflow('wf-1');
    assert.equal(runs[0]!.workflowVersion, 7);
  });

  it('sorts active runs ahead of terminal ones so the LIMIT window cannot hide them', async () => {
    const { pool, issued } = fakePool([]);
    await new ConductorRunStore(pool).listForWorkflow('wf-1');
    const s = issued[0]!.sql;
    assert.ok(s.includes(`ORDER BY (r.status IN (${ACTIVE_RUN_STATUS_SQL})) DESC, r.started_at DESC`), s);
  });

  // The invariant the whole fix rests on: the history and the delete guard must
  // call the SAME runs active. Their disagreement was the bug, so the shared
  // constant is asserted to reach both queries — not just to exist.
  it('shares its active-run predicate with the delete guard (hasActiveRuns)', async () => {
    const history = fakePool([]);
    await new ConductorRunStore(history.pool).listForWorkflow('wf-1');
    const guard = fakePool([{ count: '0' }]);
    await new ConductorWorkflowStore(guard.pool).hasActiveRuns('wf-1');

    const predicate = `IN (${ACTIVE_RUN_STATUS_SQL})`;
    assert.ok(history.issued[0]!.sql.includes(predicate), history.issued[0]!.sql);
    assert.ok(guard.issued[0]!.sql.includes(predicate), guard.issued[0]!.sql);
    assert.deepEqual([...ACTIVE_RUN_STATUSES], ['running', 'waiting']);
  });
});

// ---------------------------------------------------------------------------
// Route: GET /:slug/runs, and the cancel → delete escape
// ---------------------------------------------------------------------------

const servers: Server[] = [];

interface Harness {
  baseUrl: string;
  workflowRows: ConductorWorkflow[];
  /** The workflow's runs across versions — mutated by the stubbed cancel. */
  runs: ConductorRunListEntry[];
  /** workflow ids listForWorkflow was called with. */
  listedWorkflowIds: string[];
  /** version ids listForVersion was called with — must stay empty for this route. */
  listedVersionIds: string[];
  removedLogical: string[];
}

function waitingRun(overrides: Partial<ConductorRunListEntry> = {}): ConductorRunListEntry {
  return {
    id: RUN_OLD_ID,
    workflowVersionId: 'ver-1',
    workflowVersion: 1,
    status: 'waiting',
    currentStepId: 'approve',
    context: {},
    triggerKind: 'manual',
    triggerSource: null,
    isDryRun: false,
    startedAt: new Date('2026-11-01T10:00:00.000Z'),
    endedAt: null,
    cancelRequestedBy: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

async function makeHarness(): Promise<Harness> {
  const workflowRows: ConductorWorkflow[] = [];
  // The waiting run of the SUPERSEDED version — the row the operator needs in
  // order to reach its cancel button.
  const runs: ConductorRunListEntry[] = [waitingRun()];
  const listedWorkflowIds: string[] = [];
  const listedVersionIds: string[] = [];
  const removedLogical: string[] = [];

  const deps = {
    workflowStore: {
      getBySlug: async (slug: string): Promise<ConductorWorkflow | null> =>
        workflowRows.find((w) => w.slug === slug) ?? null,
      // The real query counts across versions; this mirrors it off the same rows
      // the history serves, which is exactly the agreement #1710 was about.
      hasActiveRuns: async (): Promise<boolean> => runs.some((r) => ACTIVE_RUN_STATUSES.includes(r.status)),
      hardDeleteUnreferenced: async (): Promise<boolean> => false,
      removeLogical: async (workflowId: string): Promise<void> => {
        removedLogical.push(workflowId);
      },
    },
    runStore: {
      listForWorkflow: async (workflowId: string): Promise<ConductorRunListEntry[]> => {
        listedWorkflowIds.push(workflowId);
        return runs;
      },
      listForVersion: async (versionId: string): Promise<ConductorRunListEntry[]> => {
        listedVersionIds.push(versionId);
        return [];
      },
    },
    executor: {
      cancelRun: async (runId: string, requestedBy: string): Promise<ConductorRunListEntry> => {
        const run = runs.find((r) => r.id === runId);
        if (!run) throw new Error(`unknown run '${runId}'`);
        run.status = 'cancelled';
        run.cancelRequestedBy = requestedBy;
        run.endedAt = new Date('2026-11-02T10:00:00.000Z');
        return run;
      },
    },
    awaitStore: {},
    roleStore: {},
    scheduleStore: {},
    eventRouter: {},
  } as unknown as ConductorRouterDeps;

  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/operator/conductors', createConductorRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`,
    workflowRows,
    runs,
    listedWorkflowIds,
    listedVersionIds,
    removedLogical,
  };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function manualRow(overrides: Partial<ConductorWorkflow> = {}): ConductorWorkflow {
  return {
    id: 'wf-1',
    slug: 'p09-rolle',
    name: 'P09 Rolle',
    description: null,
    status: 'enabled',
    activeVersionId: 'ver-2',
    origin: 'manual',
    reapedAt: null,
    ...overrides,
  };
}

describe('GET /:slug/runs', () => {
  it('lists runs of the WORKFLOW, so a republish no longer empties the history', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow());
    const res = await fetch(`${h.baseUrl}/p09-rolle/runs`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runs: Array<{ id: string; status: string; workflowVersion: number }> };
    assert.deepEqual(
      body.runs.map((r) => [r.id, r.status, r.workflowVersion]),
      [[RUN_OLD_ID, 'waiting', 1]],
      'the waiting run of superseded version 1 stays listed under active version 2',
    );
    assert.deepEqual(h.listedWorkflowIds, ['wf-1']);
    assert.deepEqual(h.listedVersionIds, [], 'the per-version listing is what hid the run');
  });

  it('answers an empty history — not 404 — for a workflow with no active version', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow({ activeVersionId: null }));
    const res = await fetch(`${h.baseUrl}/p09-rolle/runs`);
    assert.equal(res.status, 200);
    assert.deepEqual(h.listedWorkflowIds, ['wf-1']);
  });

  it('404 on an unknown slug', async () => {
    const h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/nope/runs`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.not_found');
  });
});

// The dead end in the issue, end to end: the only way out was to read the run id
// out of the database. Each step here is one operator click.
describe('the cancel → delete escape for a superseded waiting run', () => {
  it('lists the run, cancels it, and then lets DELETE through', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow());

    const listed = (await (await fetch(`${h.baseUrl}/p09-rolle/runs`)).json()) as {
      runs: Array<{ id: string; workflowVersion: number }>;
    };
    assert.deepEqual(listed.runs.map((r) => r.id), [RUN_OLD_ID], 'the cancel button needs this row');

    const blocked = await fetch(`${h.baseUrl}/p09-rolle`, { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.equal(((await blocked.json()) as { code: string }).code, 'conductor.has_active_runs');

    const cancelled = await fetch(`${h.baseUrl}/p09-rolle/runs/${listed.runs[0]!.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as { run: { status: string } }).run.status, 'cancelled');

    const deleted = await fetch(`${h.baseUrl}/p09-rolle`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true, mode: 'soft' });
    assert.deepEqual(h.removedLogical, ['wf-1']);
  });
});
