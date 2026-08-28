import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool } from 'pg';

import { ConductorEphemeralStore } from '../src/conductor/ephemeralStore.js';

// #330 — fake-pool harness in the conductorWorkflowStore.test.ts style: pg
// responses are scripted by SQL shape, and the assertions pin the predicates
// that carry the semantics (origin filter, reaped_at guard, the NOT-EXISTS
// delete guard, the idempotent cancel-request).

interface IssuedQuery {
  sql: string;
  params: unknown[];
}

function fakePool(respond: (sql: string) => { rows: unknown[]; rowCount?: number }): {
  pool: Pool;
  queries: IssuedQuery[];
} {
  const queries: IssuedQuery[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount?: number }> => {
      queries.push({ sql, params });
      return respond(sql.replace(/\s+/g, ' ').trim());
    },
  } as unknown as Pool;
  return { pool, queries };
}

function norm(q: IssuedQuery): string {
  return q.sql.replace(/\s+/g, ' ').trim();
}

describe('ConductorEphemeralStore', () => {
  it('counts active runs per agent over ephemeral workflows only', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ count: '2' }] }));
    const n = await new ConductorEphemeralStore(pool).countActiveRunsByAgent('agent-1');

    assert.equal(n, 2);
    const sql = norm(queries[0]!);
    assert.ok(sql.includes("w.origin = 'ephemeral'"));
    assert.ok(sql.includes('w.created_by_agent = $1'));
    assert.ok(sql.includes("r.status IN ('running', 'waiting')"));
    assert.deepEqual(queries[0]!.params, ['agent-1']);
  });

  it('counts recent creates per agent since the cutoff', async () => {
    const cutoff = new Date('2026-08-21T09:00:00.000Z');
    const { pool, queries } = fakePool(() => ({ rows: [{ count: '7' }] }));
    const n = await new ConductorEphemeralStore(pool).countRecentCreatesByAgent('agent-1', cutoff);

    assert.equal(n, 7);
    const sql = norm(queries[0]!);
    assert.ok(sql.includes("origin = 'ephemeral'"));
    assert.ok(sql.includes('created_at > $2'));
    assert.deepEqual(queries[0]!.params, ['agent-1', cutoff]);
  });

  it('listReapable selects expired OR all-runs-terminal, never already-reaped rows', async () => {
    const { pool, queries } = fakePool(() => ({
      rows: [{ id: 'wf-1', slug: 'eph-x', expired: true }],
    }));
    const now = new Date('2026-08-21T10:00:00.000Z');
    const rows = await new ConductorEphemeralStore(pool).listReapable(now);

    assert.deepEqual(rows, [{ id: 'wf-1', slug: 'eph-x', expired: true }]);
    const sql = norm(queries[0]!);
    assert.ok(sql.includes('w.reaped_at IS NULL'));
    assert.ok(sql.includes('w.expires_at <= $1'));
    // Terminal branch: at least one run exists AND none is still active.
    assert.ok(sql.includes('EXISTS'));
    assert.ok(sql.includes('NOT EXISTS'));
    assert.deepEqual(queries[0]!.params, [now]);
  });

  it('requestCancelActiveRuns only touches active runs without an existing request', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [], rowCount: 2 }));
    const n = await new ConductorEphemeralStore(pool).requestCancelActiveRuns('wf-1', 'reaper');

    assert.equal(n, 2);
    const sql = norm(queries[0]!);
    assert.ok(sql.startsWith('UPDATE conductor_runs'));
    assert.ok(sql.includes("status IN ('running', 'waiting')"));
    assert.ok(sql.includes('cancel_requested_at IS NULL'));
    assert.deepEqual(queries[0]!.params, ['wf-1', 'reaper']);
  });

  it('markReaped disables + stamps exactly once (idempotent WHERE)', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [] }));
    await new ConductorEphemeralStore(pool).markReaped('wf-1');

    const sql = norm(queries[0]!);
    assert.ok(sql.includes("SET status = 'disabled', reaped_at = now()"));
    assert.ok(sql.includes("origin = 'ephemeral'"));
    assert.ok(sql.includes('reaped_at IS NULL'));
  });

  it('hardDeleteUnreferenced deletes only when no run references the workflow', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [], rowCount: 0 }));
    const deleted = await new ConductorEphemeralStore(pool).hardDeleteUnreferenced('wf-1');

    assert.equal(deleted, false);
    const sql = norm(queries[0]!);
    assert.ok(sql.startsWith('DELETE FROM conductor_workflows'));
    assert.ok(sql.includes("w.origin = 'ephemeral'"));
    assert.ok(sql.includes('NOT EXISTS'));
    assert.ok(sql.includes('conductor_runs'));
  });
});
