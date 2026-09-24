import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

/**
 * #1093 defense in depth — `datasets.id` is a `uuid` column, so binding a
 * non-uuid id raises Postgres `22P02` (`invalid input syntax for type uuid`)
 * BEFORE the `owner_omadia_user_id` check in the same statement ever runs.
 * The `query_dataset` tool now rejects such ids up front, but this layer must
 * not be able to throw for ANY caller (the HTTP routes in
 * `src/routes/datasets.ts` take the id straight from the URL path, where a
 * 22P02 surfaced as a 500 with the raw Postgres message in the body).
 *
 * Hermetic on purpose — unlike the other Neon tests it needs no
 * `DATABASE_URL`: the fake pool THROWS on any query, so "returned null"
 * proves the guard short-circuits before SQL, which a live DB could not
 * distinguish from "row not found".
 */
function explodingPool(): { pool: Pool; queries: number; connects: number } {
  const state = { queries: 0, connects: 0 };
  const pool = {
    query: (): never => {
      state.queries += 1;
      throw new Error('pool.query must not be reached for a non-uuid id');
    },
    connect: (): never => {
      state.connects += 1;
      throw new Error('pool.connect must not be reached for a non-uuid id');
    },
  } as unknown as Pool;
  return {
    pool,
    get queries(): number {
      return state.queries;
    },
    get connects(): number {
      return state.connects;
    },
  };
}

const NON_UUID_IDS = [
  'ds_00000000-0000-0000-0000-000000000000', // Privacy-Shield in-memory id
  'not-a-uuid',
  '',
  '11111111-2222-3333-4444-55555555555', // one hex digit short
  "'; DROP TABLE datasets; --",
];

describe('NeonKnowledgeGraph — dataset id guard (#1093)', () => {
  for (const id of NON_UUID_IDS) {
    const label = id === '' ? '<empty>' : id;

    it(`getDataset("${label}") resolves null without querying`, async () => {
      const fake = explodingPool();
      const graph = new NeonKnowledgeGraph({ pool: fake.pool, tenantId: 't' });
      assert.equal(await graph.getDataset(id, 'user-1'), null);
      assert.equal(fake.queries, 0);
    });

    it(`queryDatasetRows("${label}") resolves null without querying`, async () => {
      const fake = explodingPool();
      const graph = new NeonKnowledgeGraph({ pool: fake.pool, tenantId: 't' });
      assert.equal(await graph.queryDatasetRows(id, 'user-1', {}), null);
      assert.equal(fake.queries, 0);
    });

    it(`deleteDataset("${label}") resolves false without connecting`, async () => {
      const fake = explodingPool();
      const graph = new NeonKnowledgeGraph({ pool: fake.pool, tenantId: 't' });
      assert.equal(
        await graph.deleteDataset(id, { actorOmadiaUserId: 'user-1' }),
        false,
      );
      assert.equal(fake.connects, 0);
    });
  }

  // Postgres accepts these spellings for `uuid` input, so ids that resolved
  // before any validation existed must keep resolving — the guard must not
  // quietly turn an existing dataset into a 404 / "deleted nothing".
  for (const spelling of [
    '11111111-2222-3333-4444-555555555555',
    '11111111222233334444555555555555',
    '{11111111-2222-3333-4444-555555555555}',
    '11111111-AAAA-4BBB-8CCC-555555555555',
    '  11111111-2222-3333-4444-555555555555  ',
  ]) {
    it(`accepts the uuid spelling "${spelling}"`, async () => {
      const fake = explodingPool();
      const graph = new NeonKnowledgeGraph({ pool: fake.pool, tenantId: 't' });
      await assert.rejects(
        () => graph.getDataset(spelling, 'user-1'),
        /pool\.query must not be reached/,
        'this spelling must reach the pool, not be refused',
      );
      assert.equal(fake.queries, 1);
    });
  }

  it('lets a well-formed uuid through to the pool (the guard is narrow)', async () => {
    const fake = explodingPool();
    const graph = new NeonKnowledgeGraph({ pool: fake.pool, tenantId: 't' });
    await assert.rejects(
      () => graph.getDataset('11111111-2222-3333-4444-555555555555', 'user-1'),
      /pool\.query must not be reached/,
    );
    assert.equal(fake.queries, 1);
  });
});
