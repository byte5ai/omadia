/**
 * The memory-access world seeded into the Neon backend (pgvector): every
 * canary reads back from its store, including process memory, which only
 * Neon has. This is the positive control the Postgres leg of the ACL contract
 * suite (step 2) stands on. The `/memories` tree uses the in-memory store
 * here; the Postgres memory store has its own conformance suite.
 *
 * Needs a pgvector Postgres in GRAPH_PG_TEST_URL or MEMORY_PG_TEST_URL;
 * skips without one (issue #572). Runs in `npm run test:pg`.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';
import { InMemoryMemoryStore } from '@omadia/memory';
import type { EmbeddingClient } from '@omadia/plugin-api';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { readBack, seedWorld, type Seeded } from './seed.js';
import { TENANTS, buildWorld, type TenantKey } from './world.js';

const DIM = 768;
const VECTOR = `[${Array.from({ length: DIM }, (_, i) => (i % 7) / 7 + 0.01).join(',')}]`;

/** One-hot per process text, so no two processes count as duplicates. */
function processEmbedder(): EmbeddingClient {
  const slots = new Map<string, number>();
  return {
    async embed(text: string) {
      if (!slots.has(text)) slots.set(text, slots.size % DIM);
      const v = Array.from({ length: DIM }, () => 0);
      v[slots.get(text)!] = 1;
      return v;
    },
  } as unknown as EmbeddingClient;
}

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryAccess/seed',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

describe('memory-access seed · NeonKnowledgeGraph (real PG)', () => {
  const run = Date.now();
  const tenantId = (k: TenantKey): string => `${TENANTS[k]}-${run}`;
  const world = buildWorld();
  let pool: Pool | undefined;
  let seeded: Seeded;

  before(async () => {
    if (!pgUp) return;
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await runGraphMigrations(pool);
    const p = pool;
    const store = (k: TenantKey) => {
      const embedder = processEmbedder();
      return {
        graph: new NeonKnowledgeGraph({ pool: p, tenantId: tenantId(k) }),
        memory: new InMemoryMemoryStore(),
        processes: new NeonProcessMemoryStore({
          pool: p,
          tenantId: tenantId(k),
          resolveEmbeddingClient: () => embedder,
        }),
      };
    };
    seeded = await seedWorld(
      world,
      { main: store('main'), other: store('other') },
      async (k, id) => {
        await p.query(
          'UPDATE graph_nodes SET embedding = $1::vector WHERE tenant_id = $2 AND external_id = $3',
          [VECTOR, tenantId(k), id],
        );
      },
    );
  });

  after(async () => {
    if (!pool) return;
    const tenants = [tenantId('main'), tenantId('other')];
    for (const table of [
      'graph_edges',
      'graph_nodes',
      'datasets',
      'process_history',
      'processes',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [tenants]);
    }
    await pool.end();
  });

  it('every canary reads back from its store (positive control)', async (t) => {
    if (!pool) return t.skip('no test database');
    assert.deepEqual(seeded.skipped, [], 'Neon takes every store');
    const missing: string[] = [];
    for (const item of world.items) {
      const text = await readBack(seeded, item);
      if (!text?.includes(item.canary)) missing.push(`${item.store} ${item.canary}`);
    }
    assert.deepEqual(missing, []);
  });
});
