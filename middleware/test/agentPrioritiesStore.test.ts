import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, QueryResult } from 'pg';

import { NeonAgentPrioritiesStore } from '@omadia/knowledge-graph-neon/dist/agentPrioritiesStore.js';

// ---------------------------------------------------------------------------
// FakePool — captures pool.query(sql, params) calls and returns scripted rows.
// The store does single-statement reads/writes (no transaction), so a flat
// queue is enough.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeFakePool(opts: {
  /** Rows returned by SELECTs, in order. Each entry is one query's `rows`. */
  rowsScript?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const rowsScript = opts.rowsScript ?? [];
  let selectIndex = 0;

  const pool = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
      queries.push({ sql, params: params ?? [] });
      const isSelect = /^\s*SELECT/i.test(sql);
      const rows = isSelect ? (rowsScript[selectIndex] ?? []) : [];
      if (isSelect) selectIndex += 1;
      return {
        command: '',
        rowCount: rows.length,
        oid: 0,
        rows: [...rows],
        fields: [],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;

  return { pool, queries };
}

describe('NeonAgentPrioritiesStore', () => {
  describe('listForAgent', () => {
    it('selects with tenant + agent binding and maps rows to AgentPriorityRecord[]', async () => {
      const updatedAt = new Date('2026-05-08T10:00:00.000Z');
      const { pool, queries } = makeFakePool({
        rowsScript: [
          [
            {
              agent_id: 'de.byte5.agent.calendar',
              entry_external_id: 'turn:scope-a:2026-05-08T08:00:00.000Z',
              action: 'block',
              weight: 1.3,
              reason: 'outdated',
              updated_at: updatedAt,
            },
            {
              agent_id: 'de.byte5.agent.calendar',
              entry_external_id: 'turn:scope-b:2026-05-08T08:30:00.000Z',
              action: 'boost',
              weight: 2.0,
              reason: null,
              updated_at: updatedAt,
            },
          ],
        ],
      });
      const store = new NeonAgentPrioritiesStore({
        pool,
        tenantId: 'tenant-test',
      });

      const records = await store.listForAgent('de.byte5.agent.calendar');

      assert.equal(queries.length, 1);
      const q = queries[0];
      assert.ok(q !== undefined);
      assert.ok(/SELECT[\s\S]+FROM agent_priorities/i.test(q.sql));
      assert.ok(/WHERE tenant_id = \$1[\s\S]+AND agent_id = \$2/i.test(q.sql));
      assert.deepEqual(q.params, ['tenant-test', 'de.byte5.agent.calendar']);

      assert.equal(records.length, 2);
      assert.deepEqual(records[0], {
        agentId: 'de.byte5.agent.calendar',
        entryExternalId: 'turn:scope-a:2026-05-08T08:00:00.000Z',
        action: 'block',
        weight: 1.3,
        reason: 'outdated',
        updatedAt: '2026-05-08T10:00:00.000Z',
      });
      assert.equal(records[1]?.action, 'boost');
      assert.equal(records[1]?.weight, 2.0);
      assert.equal(records[1]?.reason, null);
    });

    it('returns [] when no rows match', async () => {
      const { pool } = makeFakePool({ rowsScript: [[]] });
      const store = new NeonAgentPrioritiesStore({
        pool,
        tenantId: 'tenant-test',
      });
      const records = await store.listForAgent('any-agent');
      assert.deepEqual(records, []);
    });
  });

  describe('upsert', () => {
    it('writes INSERT … ON CONFLICT with tenant-scoped params', async () => {
      const { pool, queries } = makeFakePool({});
      const store = new NeonAgentPrioritiesStore({
        pool,
        tenantId: 'tenant-test',
      });

      await store.upsert({
        agentId: 'de.byte5.agent.calendar',
        entryExternalId: 'turn:scope-a:2026-05-08T08:00:00.000Z',
        action: 'block',
        weight: 1.3,
        reason: 'outdated',
      });

      assert.equal(queries.length, 1);
      const q = queries[0];
      assert.ok(q !== undefined);
      assert.ok(/INSERT INTO agent_priorities/i.test(q.sql));
      assert.ok(/ON CONFLICT \(tenant_id, agent_id, entry_external_id\) DO UPDATE/i.test(q.sql));
      assert.ok(/updated_at = NOW\(\)/i.test(q.sql));
      assert.deepEqual(q.params, [
        'tenant-test',
        'de.byte5.agent.calendar',
        'turn:scope-a:2026-05-08T08:00:00.000Z',
        'block',
        1.3,
        'outdated',
      ]);
    });

    it('rejects an invalid action with a clear error', async () => {
      const { pool } = makeFakePool({});
      const store = new NeonAgentPrioritiesStore({
        pool,
        tenantId: 'tenant-test',
      });

      await assert.rejects(
        () =>
          store.upsert({
            agentId: 'a',
            entryExternalId: 'e',
            // intentional cast — runtime guard target
            action: 'maybe' as 'block' | 'boost',
            weight: 1.3,
            reason: null,
          }),
        /invalid action/i,
      );
    });

    it('rejects a non-finite weight', async () => {
      const { pool } = makeFakePool({});
      const store = new NeonAgentPrioritiesStore({
        pool,
        tenantId: 'tenant-test',
      });

      await assert.rejects(
        () =>
          store.upsert({
            agentId: 'a',
            entryExternalId: 'e',
            action: 'boost',
            weight: Number.NaN,
            reason: null,
          }),
        /invalid weight/i,
      );
    });
  });

  describe('remove', () => {
    it('issues DELETE with tenant + agent + entry binding', async () => {
      const { pool, queries } = makeFakePool({});
      const store = new NeonAgentPrioritiesStore({
        pool,
        tenantId: 'tenant-test',
      });

      await store.remove('de.byte5.agent.calendar', 'turn:scope-a:2026-05-08T08:00:00.000Z');

      assert.equal(queries.length, 1);
      const q = queries[0];
      assert.ok(q !== undefined);
      assert.ok(/DELETE FROM agent_priorities/i.test(q.sql));
      assert.ok(/WHERE tenant_id = \$1[\s\S]+AND agent_id = \$2[\s\S]+AND entry_external_id = \$3/i.test(q.sql));
      assert.deepEqual(q.params, [
        'tenant-test',
        'de.byte5.agent.calendar',
        'turn:scope-a:2026-05-08T08:00:00.000Z',
      ]);
    });
  });
});
