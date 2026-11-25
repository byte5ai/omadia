/**
 * `QueryProcessesInput.agentScopePrefix` in the Neon store, against a real
 * pgvector Postgres (`GRAPH_PG_TEST_URL`; skipped without one). The filter
 * runs before `limit`: other agents' better-scoring processes must not crowd
 * this agent's out (query_processes used to over-fetch and filter after the
 * store's 50-row cap). The default agent also owns the legacy unqualified
 * scopes, and the prefix is matched literally, not as a LIKE pattern.
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';
import type { EmbeddingClient } from '@omadia/plugin-api';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'process-agent-scope-query';
const DIMENSIONS = 768;

/** Cosine similarity to the query per keyword: the query vector is the unit
 *  vector on axis 0, each process gets `w` on axis 0 and the rest on its own
 *  axis, so its score is `w` and two processes stay far below the dedup
 *  threshold. Foreign processes score higher than the own ones. */
const SIMILARITY: ReadonlyArray<readonly [keyword: string, similarity: number]> = [
  ['Fremd-A', 0.8],
  ['Fremd-B', 0.75],
  ['Fremd-C', 0.7],
  ['Eigen', 0.5],
  ['Altbestand', 0.45],
  ['Standard', 0.4],
];

const embedder: EmbeddingClient = {
  async embed(text: string) {
    const v = Array.from({ length: DIMENSIONS }, () => 0);
    const index = SIMILARITY.findIndex(([keyword]) => text.includes(keyword));
    if (index < 0) {
      v[0] = 1;
      return v;
    }
    const w = SIMILARITY[index]![1];
    v[0] = w;
    v[index + 1] = Math.sqrt(1 - w * w);
    return v;
  },
} as unknown as EmbeddingClient;

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'processAgentScopeQuery',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function clean(p: Pool): Promise<void> {
  await p.query('DELETE FROM process_history WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM processes WHERE tenant_id = $1', [TENANT]);
}

after(async () => {
  if (!pool) return;
  await clean(pool);
  await pool.end();
});

describe('NeonProcessMemoryStore · agentScopePrefix (real PG)', () => {
  it('filters to the agent before the limit, legacy scopes belong to default', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await clean(pool);
    const store = new NeonProcessMemoryStore({ pool, tenantId: TENANT, resolveEmbeddingClient: () => embedder });

    const seed: ReadonlyArray<readonly [title: string, scope: string]> = [
      ['Fremd-A: Prozess', 'sales::chat-1'],
      ['Fremd-B: Prozess', 'sales::chat-2'],
      ['Fremd-C: Prozess', 'hrx::chat-3'],
      ['Eigen: Prozess', 'hr::chat-4'],
      ['Altbestand: Prozess', 'legacy-chat'],
      ['Standard: Prozess', 'default::chat-5'],
    ];
    for (const [title, scope] of seed) {
      const written = await store.write({ title, steps: ['schritt'], scope });
      assert.ok(written.ok, `${title} not written`);
    }

    const titles = async (input: { limit: number; agentScopePrefix?: string }) =>
      (await store.query({ query: 'prozess', ...input })).map((h) => h.record.title);

    // Without the filter the foreign processes win the limit.
    assert.deepEqual(await titles({ limit: 1 }), ['Fremd-A: Prozess']);
    assert.deepEqual(await titles({ limit: 1, agentScopePrefix: 'hr::' }), ['Eigen: Prozess']);
    assert.deepEqual(await titles({ limit: 10, agentScopePrefix: 'default::' }), [
      'Altbestand: Prozess',
      'Standard: Prozess',
    ]);
    // `_` is a LIKE wildcard; the prefix must match literally.
    assert.deepEqual(await titles({ limit: 10, agentScopePrefix: 'h_::' }), []);
  });
});
