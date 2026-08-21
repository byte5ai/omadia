import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';

import type { WorkflowGraph } from '@omadia/conductor-core';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import { ConductorWorkflowStore, WorkflowSlugExistsError } from '../src/conductor/workflowStore.js';
import type { ConductorWorkflow } from '../src/conductor/workflowStore.js';

// Workflow deletion (operator DELETE /:slug) — two removal shapes mirroring the
// #330 ephemeral reaper, extended to manual workflows: physical DELETE when no
// run references any version, logical removal (disabled + reaped_at) otherwise.
// Store tests script pg responses by SQL shape (no DB); route tests run the real
// router over an express harness with a stubbed store.

// ---------------------------------------------------------------------------
// Store: SQL shapes
// ---------------------------------------------------------------------------

function scriptedPool(respond: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number }): {
  pool: Pool;
  issued: Array<{ sql: string; params: unknown[] }>;
} {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      issued.push({ sql: s, params });
      const r = respond(s, params);
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
    },
  } as unknown as Pool;
  return { pool, issued };
}

describe('ConductorWorkflowStore deletion shapes', () => {
  it('list() hides logically removed rows (reaped_at IS NULL joins the manual filter)', async () => {
    const { pool, issued } = scriptedPool(() => ({ rows: [] }));
    await new ConductorWorkflowStore(pool).list();
    assert.equal(issued.length, 1);
    assert.ok(issued[0]!.sql.includes("WHERE origin = 'manual' AND reaped_at IS NULL"), issued[0]!.sql);
  });

  it('removeLogical disables workflow + its cron schedules atomically, guarded to un-reaped manual rows', async () => {
    const { pool, issued } = scriptedPool(() => ({ rowCount: 1 }));
    await new ConductorWorkflowStore(pool).removeLogical('wf-1');
    assert.equal(issued.length, 1, 'one statement — workflow and schedules disable atomically');
    const s = issued[0]!.sql;
    assert.ok(s.includes('UPDATE conductor_workflows'), s);
    assert.ok(s.includes("SET status = 'disabled', reaped_at = now()"), s);
    assert.ok(s.includes("origin = 'manual' AND reaped_at IS NULL"), s);
    assert.ok(s.includes('UPDATE conductor_schedules'), s);
    assert.deepEqual(issued[0]!.params, ['wf-1']);
  });

  it('setStatus cannot resurrect a reaped row (reaped_at IS NULL guard)', async () => {
    const { pool, issued } = scriptedPool(() => ({ rowCount: 0 }));
    await new ConductorWorkflowStore(pool).setStatus('demo', 'enabled');
    assert.ok(issued[0]!.sql.includes('reaped_at IS NULL'), issued[0]!.sql);
  });

  it('createOrPublish upsert refuses a reaped slug (zero-row DO UPDATE → WorkflowSlugExistsError)', async () => {
    const issued: string[] = [];
    const client = {
      query: async (sql: string): Promise<{ rows: unknown[] }> => {
        const s = sql.replace(/\s+/g, ' ').trim();
        issued.push(s);
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
        // The reaped row: the DO UPDATE's WHERE filtered it out → zero returned rows.
        if (s.startsWith('INSERT INTO conductor_workflows ')) return { rows: [] };
        throw new Error(`unscripted query: ${s}`);
      },
      release: (): void => {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const graph: WorkflowGraph = { entryStepId: 's', steps: [{ id: 's', kind: 'agent', agentId: 'a', prompt: 'p' }], transitions: [] };
    await assert.rejects(
      new ConductorWorkflowStore(pool).createOrPublish({ slug: 'deleted', name: 'X', graph }),
      (err: unknown) => err instanceof WorkflowSlugExistsError,
    );
    const insert = issued.find((s) => s.startsWith('INSERT INTO conductor_workflows '));
    assert.ok(insert?.includes('WHERE conductor_workflows.reaped_at IS NULL'), insert ?? 'insert not issued');
    assert.ok(issued.includes('ROLLBACK'), 'nothing may commit onto the reaped row');
  });

  it('hardDeleteUnreferenced deletes only manual rows no run references and reports the outcome', async () => {
    const hit = scriptedPool(() => ({ rowCount: 1 }));
    assert.equal(await new ConductorWorkflowStore(hit.pool).hardDeleteUnreferenced('wf-1'), true);
    const s = hit.issued[0]!.sql;
    assert.ok(s.startsWith('DELETE FROM conductor_workflows'), s);
    assert.ok(s.includes("w.origin = 'manual'"), s);
    assert.ok(s.includes('NOT EXISTS'), s);
    assert.ok(s.includes('conductor_runs'), s);

    const miss = scriptedPool(() => ({ rowCount: 0 }));
    assert.equal(await new ConductorWorkflowStore(miss.pool).hardDeleteUnreferenced('wf-1'), false);
  });

  it('hasActiveRuns counts running/waiting runs across all versions', async () => {
    const active = scriptedPool(() => ({ rows: [{ count: '2' }] }));
    assert.equal(await new ConductorWorkflowStore(active.pool).hasActiveRuns('wf-1'), true);
    const s = active.issued[0]!.sql;
    assert.ok(s.includes("r.status IN ('running', 'waiting')"), s);
    assert.ok(s.includes('conductor_workflow_versions'), s);

    const idle = scriptedPool(() => ({ rows: [{ count: '0' }] }));
    assert.equal(await new ConductorWorkflowStore(idle.pool).hasActiveRuns('wf-1'), false);
  });
});

// ---------------------------------------------------------------------------
// Route: DELETE /:slug
// ---------------------------------------------------------------------------

interface DeleteCalls {
  hard: string[];
  logical: string[];
}

interface Harness {
  baseUrl: string;
  workflowRows: ConductorWorkflow[];
  calls: DeleteCalls;
  activeRunWorkflowIds: Set<string>;
  /** ids hardDeleteUnreferenced refuses (runs reference them) → logical fallback. */
  referencedWorkflowIds: Set<string>;
  /** ids whose hard DELETE raises FK 23503 (run raced in) → logical fallback. */
  fkViolationWorkflowIds: Set<string>;
}

const servers: Server[] = [];

async function makeHarness(): Promise<Harness> {
  const workflowRows: ConductorWorkflow[] = [];
  const calls: DeleteCalls = { hard: [], logical: [] };
  const activeRunWorkflowIds = new Set<string>();
  const referencedWorkflowIds = new Set<string>();
  const fkViolationWorkflowIds = new Set<string>();

  const workflowStore = {
    list: async (): Promise<ConductorWorkflow[]> => [...workflowRows],
    getBySlug: async (slug: string): Promise<ConductorWorkflow | null> =>
      workflowRows.find((w) => w.slug === slug) ?? null,
    hasActiveRuns: async (id: string): Promise<boolean> => activeRunWorkflowIds.has(id),
    hardDeleteUnreferenced: async (id: string): Promise<boolean> => {
      calls.hard.push(id);
      if (fkViolationWorkflowIds.has(id)) throw Object.assign(new Error('fk violation'), { code: '23503' });
      return !referencedWorkflowIds.has(id);
    },
    removeLogical: async (id: string): Promise<void> => {
      calls.logical.push(id);
    },
  };

  const deps = {
    workflowStore,
    runStore: {},
    awaitStore: {},
    roleStore: {},
    scheduleStore: {},
    executor: {},
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
    calls,
    activeRunWorkflowIds,
    referencedWorkflowIds,
    fkViolationWorkflowIds,
  };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function manualRow(overrides: Partial<ConductorWorkflow> = {}): ConductorWorkflow {
  return {
    id: 'wf-1',
    slug: 'demo',
    name: 'Demo',
    description: null,
    status: 'enabled',
    activeVersionId: 'ver-1',
    origin: 'manual',
    reapedAt: null,
    ...overrides,
  };
}

async function del(url: string): Promise<Response> {
  return fetch(url, { method: 'DELETE' });
}

describe('DELETE /:slug', () => {
  it('404 on an unknown slug', async () => {
    const h = await makeHarness();
    const res = await del(`${h.baseUrl}/nope`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.not_found');
  });

  it('404 on an already-removed (reaped) row — delete is not re-runnable', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow({ reapedAt: new Date() }));
    assert.equal((await del(`${h.baseUrl}/demo`)).status, 404);
    assert.deepEqual(h.calls, { hard: [], logical: [] });
  });

  it("400 on the 'eph-' namespace — ephemeral lifecycle owns those", async () => {
    const h = await makeHarness();
    const res = await del(`${h.baseUrl}/eph-agent-1`);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.reserved_slug_prefix');
  });

  it('409 conductor.has_active_runs while runs are running/waiting — nothing is removed', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow());
    h.activeRunWorkflowIds.add('wf-1');
    const res = await del(`${h.baseUrl}/demo`);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'conductor.has_active_runs');
    assert.deepEqual(h.calls, { hard: [], logical: [] });
  });

  it('physically deletes an unreferenced workflow (mode hard, no logical fallback)', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow());
    const res = await del(`${h.baseUrl}/demo`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true, mode: 'hard' });
    assert.deepEqual(h.calls, { hard: ['wf-1'], logical: [] });
  });

  it('GET /:slug answers 404 for a logically removed workflow — deleted rows are not readable', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow({ reapedAt: new Date() }));
    const res = await fetch(`${h.baseUrl}/demo`);
    assert.equal(res.status, 404);
  });

  it('falls back to soft when the hard DELETE loses the race to a new run (FK 23503)', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow());
    h.fkViolationWorkflowIds.add('wf-1');
    const res = await del(`${h.baseUrl}/demo`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true, mode: 'soft' });
    assert.deepEqual(h.calls.logical, ['wf-1']);
  });

  it('falls back to logical removal when runs reference the workflow (mode soft)', async () => {
    const h = await makeHarness();
    h.workflowRows.push(manualRow());
    h.referencedWorkflowIds.add('wf-1');
    const res = await del(`${h.baseUrl}/demo`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { deleted: true, mode: 'soft' });
    assert.deepEqual(h.calls, { hard: ['wf-1'], logical: ['wf-1'] });
  });
});
