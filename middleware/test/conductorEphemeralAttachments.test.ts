import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool } from 'pg';

import { ConductorEphemeralAttachmentsStore } from '../src/conductor/ephemeralAttachmentsStore.js';

// #330 C2a — fake-pool harness (conductorEphemeralStore.test.ts style): the
// SQL predicates carry the semantics — pending-only expiry refresh, the
// state check on attach, the pending-only expiry listing.

interface IssuedQuery {
  sql: string;
  params: unknown[];
}

const ROW = {
  id: '1',
  workflow_id: null,
  agent_slug: 'facilitator',
  channel_type: 'teams',
  channel_key: 'conv-1',
  role_key: null,
  state: 'pending',
  expires_at: new Date('2026-08-22T10:00:00.000Z'),
};

function fakePool(rows: unknown[] = [ROW]): { pool: Pool; queries: IssuedQuery[] } {
  const queries: IssuedQuery[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
      queries.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, queries };
}

function norm(q: IssuedQuery): string {
  return q.sql.replace(/\s+/g, ' ').trim();
}

describe('ConductorEphemeralAttachmentsStore', () => {
  it('upsertPending refreshes expiry ONLY while still pending (attached rows are owned by the run)', async () => {
    const { pool, queries } = fakePool();
    await new ConductorEphemeralAttachmentsStore(pool).upsertPending({
      agentSlug: 'facilitator',
      channelType: 'teams',
      channelKey: 'conv-1',
      expiresAt: new Date('2026-08-22T10:00:00.000Z'),
    });
    const sql = norm(queries[0]!);
    assert.ok(sql.includes('ON CONFLICT (channel_type, channel_key) DO UPDATE'));
    assert.ok(sql.includes("state = 'pending'"), 'expiry refresh must be pending-gated');
  });

  it('attachToWorkflow ties workflow + role and flips the state', async () => {
    const { pool, queries } = fakePool([{ ...ROW, workflow_id: 'wf-1', role_key: 'facilitation-x', state: 'attached' }]);
    const out = await new ConductorEphemeralAttachmentsStore(pool).attachToWorkflow({
      agentSlug: 'facilitator',
      channelType: 'teams',
      channelKey: 'conv-1',
      workflowId: 'wf-1',
      roleKey: 'facilitation-x',
      expiresAt: new Date('2026-08-23T10:00:00.000Z'),
    });
    assert.equal(out?.state, 'attached');
    const sql = norm(queries[0]!);
    assert.ok(sql.includes("state = 'attached'"));
    // M1 guard: only the owning agent's still-pending row is attachable.
    assert.ok(sql.includes("agent_slug = $1 AND state = 'pending'"));
  });

  it('listExpiredPending only ever selects pending rows', async () => {
    const { pool, queries } = fakePool([]);
    await new ConductorEphemeralAttachmentsStore(pool).listExpiredPending(new Date());
    const sql = norm(queries[0]!);
    assert.ok(sql.includes("state = 'pending' AND expires_at <= $1"));
  });

  it('listExpiredAttached is the H2 retry path over attached rows', async () => {
    const { pool, queries } = fakePool([]);
    await new ConductorEphemeralAttachmentsStore(pool).listExpiredAttached(new Date());
    const sql = norm(queries[0]!);
    assert.ok(sql.includes("state = 'attached' AND expires_at <= $1"));
  });

  it('upsertPending re-stamps the owning agent while pending (L2)', async () => {
    const { pool, queries } = fakePool();
    await new ConductorEphemeralAttachmentsStore(pool).upsertPending({
      agentSlug: 'facilitator', channelType: 'teams', channelKey: 'conv-1', expiresAt: new Date(),
    });
    const sql = norm(queries[0]!);
    assert.ok(sql.includes('agent_slug = CASE'));
  });
});
