import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool } from 'pg';

import {
  ConductorEphemeralRunStateStore,
  RunStateRejectedError,
  RunStateSizeExceededError,
} from '../src/conductor/ephemeralRunStateStore.js';

// Durable per-run plugin state (migration 0012). Fake-pool harness in the
// conductorEphemeralStore.test.ts style: the assertions pin the predicates that
// carry the semantics — the owner guard is in the SQL, so it must not drift.

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

const RUN_ID = '0b9f6c1e-3d2a-4c5b-8e7f-1a2b3c4d5e6f';
const NOW = new Date('2026-10-16T10:00:00.000Z');

describe('ConductorEphemeralRunStateStore.listOwnActiveRuns', () => {
  it('selects only live, un-reaped, uncancelled ephemeral runs of this agent with the state LEFT-joined', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [] }));
    await new ConductorEphemeralRunStateStore(pool).listOwnActiveRuns('agent-1', NOW);

    assert.equal(queries.length, 1);
    const sql = norm(queries[0]!);
    assert.ok(sql.includes("w.origin = 'ephemeral'"));
    assert.ok(sql.includes('w.created_by_agent = $1'));
    assert.ok(sql.includes('w.reaped_at IS NULL'));
    assert.ok(sql.includes('w.expires_at > $2'));
    assert.ok(sql.includes("r.status IN ('running', 'waiting')"));
    assert.ok(sql.includes('r.cancel_requested_at IS NULL'));
    assert.ok(sql.includes('LEFT JOIN conductor_ephemeral_run_state s ON s.run_id = r.id'));
    assert.ok(sql.includes("r.trigger_source->>'patternId' AS pattern_id"));
    assert.deepEqual(queries[0]!.params, ['agent-1', NOW]);
  });

  it('maps rows and normalizes defensive cases (null context, array state, string expiry, empty pattern)', async () => {
    const expires = new Date('2026-10-17T10:00:00.000Z');
    const { pool } = fakePool(() => ({
      rows: [
        {
          run_id: RUN_ID, workflow_id: 'wf-1', workflow_slug: 'eph-facilitation-1', expires_at: expires,
          context: { goal: 'g' }, pattern_id: 'facilitation', state: { v: 1 },
        },
        {
          run_id: 'run-2', workflow_id: 'wf-2', workflow_slug: 'eph-facilitation-2', expires_at: '2026-10-17T11:00:00.000Z',
          context: null, pattern_id: '', state: [1, 2],
        },
      ],
    }));
    const rows = await new ConductorEphemeralRunStateStore(pool).listOwnActiveRuns('agent-1', NOW);

    assert.deepEqual(rows, [
      {
        runId: RUN_ID, workflowId: 'wf-1', workflowSlug: 'eph-facilitation-1', expiresAt: expires,
        context: { goal: 'g' }, patternId: 'facilitation', state: { v: 1 },
      },
      {
        runId: 'run-2', workflowId: 'wf-2', workflowSlug: 'eph-facilitation-2',
        expiresAt: new Date('2026-10-17T11:00:00.000Z'), context: {}, patternId: null, state: null,
      },
    ]);
  });

  it('fails loudly on a malformed row instead of handing garbage to the plugin', async () => {
    const { pool } = fakePool(() => ({
      rows: [{ run_id: null, workflow_id: 'wf', workflow_slug: 's', expires_at: NOW, context: {}, pattern_id: null, state: null }],
    }));
    await assert.rejects(new ConductorEphemeralRunStateStore(pool).listOwnActiveRuns('agent-1', NOW), /malformed/);

    const badDate = fakePool(() => ({
      rows: [{ run_id: RUN_ID, workflow_id: 'wf', workflow_slug: 's', expires_at: 'not-a-date', context: {}, pattern_id: null, state: null }],
    }));
    await assert.rejects(new ConductorEphemeralRunStateStore(badDate.pool).listOwnActiveRuns('agent-1', NOW), /expires_at/);
  });
});

describe('ConductorEphemeralRunStateStore.upsertOwned', () => {
  it('is ONE owner-guarded INSERT…SELECT with ON CONFLICT upsert', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [], rowCount: 1 }));
    const saved = await new ConductorEphemeralRunStateStore(pool).upsertOwned('agent-1', RUN_ID, { v: 1, phase: 'active' });

    assert.equal(saved, true);
    assert.equal(queries.length, 1);
    const sql = norm(queries[0]!);
    assert.ok(sql.startsWith('INSERT INTO conductor_ephemeral_run_state (run_id, agent_id, state, updated_at) SELECT'));
    assert.ok(sql.includes('WHERE r.id = $1'));
    assert.ok(sql.includes('w.created_by_agent = $2'));
    assert.ok(sql.includes("w.origin = 'ephemeral'"));
    assert.ok(sql.includes('w.reaped_at IS NULL'));
    assert.ok(sql.includes("r.status IN ('running', 'waiting')"));
    // Same live-run set as listOwnActiveRuns (MEDIUM 4).
    assert.ok(sql.includes('w.expires_at > now()'));
    assert.ok(sql.includes('r.cancel_requested_at IS NULL'));
    // Purge-on-reap race: the write waits for a concurrent reap's row lock.
    assert.ok(sql.includes('FOR SHARE OF w ON CONFLICT (run_id) DO UPDATE'));
    assert.deepEqual(queries[0]!.params, [RUN_ID, 'agent-1', '{"v":1,"phase":"active"}']);
  });

  it('returns false when no owned active run matched (rowCount 0)', async () => {
    const { pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    assert.equal(await new ConductorEphemeralRunStateStore(pool).upsertOwned('agent-2', RUN_ID, {}), false);
  });

  it('maps the size CHECK violation to RunStateSizeExceededError and rethrows other pg errors', async () => {
    const check = Object.assign(new Error('check'), {
      code: '23514',
      constraint: 'conductor_ephemeral_run_state_size_check',
    });
    const failing = {
      query: async () => {
        throw check;
      },
    } as unknown as Pool;
    await assert.rejects(new ConductorEphemeralRunStateStore(failing).upsertOwned('a', RUN_ID, {}), RunStateSizeExceededError);

    const nul = Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' });
    const failingNul = {
      query: async () => {
        throw nul;
      },
    } as unknown as Pool;
    await assert.rejects(new ConductorEphemeralRunStateStore(failingNul).upsertOwned('a', RUN_ID, {}), RunStateRejectedError);

    const other = Object.assign(new Error('fk'), { code: '23503' });
    const failingOther = {
      query: async () => {
        throw other;
      },
    } as unknown as Pool;
    await assert.rejects(new ConductorEphemeralRunStateStore(failingOther).upsertOwned('a', RUN_ID, {}), other);
  });
});

describe('ConductorEphemeralRunStateStore.getOwnedRun', () => {
  it('scopes by owner + ephemeral origin but NOT by status', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ run_id: RUN_ID, status: 'completed' }] }));
    const run = await new ConductorEphemeralRunStateStore(pool).getOwnedRun('agent-1', RUN_ID);

    assert.deepEqual(run, { runId: RUN_ID, status: 'completed' });
    const sql = norm(queries[0]!);
    assert.ok(sql.includes('w.created_by_agent = $2'));
    assert.ok(sql.includes("w.origin = 'ephemeral'"));
    assert.ok(!sql.includes('r.status IN'));
    assert.deepEqual(queries[0]!.params, [RUN_ID, 'agent-1']);
  });

  it('returns null for an unknown or foreign run', async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    assert.equal(await new ConductorEphemeralRunStateStore(pool).getOwnedRun('agent-1', RUN_ID), null);
  });
});
