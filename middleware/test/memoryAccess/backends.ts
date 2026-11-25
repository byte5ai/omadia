/**
 * The memory-access world seeded into each backend: the in-memory graph and
 * Neon (pgvector). Shared by the seed self-checks and the ACL contract
 * suites, so every suite reads the same world from the same kind of store.
 */
import type { Pool } from 'pg';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';
import { InMemoryMemoryStore } from '@omadia/memory';
import type { EmbeddingClient } from '@omadia/plugin-api';

import { EMBEDDING_DIM, seedWorld, type Seeded } from './seed.js';
import { TENANTS, type TenantKey, type World } from './world.js';

export async function seedInMemory(world: World): Promise<Seeded> {
  const graphs = { main: new InMemoryKnowledgeGraph(), other: new InMemoryKnowledgeGraph() };
  return seedWorld(
    world,
    {
      main: { graph: graphs.main, memory: new InMemoryMemoryStore() },
      other: { graph: graphs.other, memory: new InMemoryMemoryStore() },
    },
    async (tenant, id, vector) => graphs[tenant].setEmbedding(id, [...vector]),
  );
}

/** One-hot per process text, so no two processes count as duplicates. */
function processEmbedder(): EmbeddingClient {
  const slots = new Map<string, number>();
  return {
    async embed(text: string) {
      if (!slots.has(text)) slots.set(text, slots.size % EMBEDDING_DIM);
      const v = Array.from({ length: EMBEDDING_DIM }, () => 0);
      v[slots.get(text)!] = 1;
      return v;
    },
  } as unknown as EmbeddingClient;
}

export interface NeonSeeded {
  readonly seeded: Seeded;
  /** Deletes every row the seed wrote. Does not end the pool. */
  readonly clean: () => Promise<void>;
}

/**
 * Seeds Neon under tenant ids unique to this run, so a rerun on the same
 * database never meets the previous run's rows.
 */
export async function seedNeon(pool: Pool, world: World): Promise<NeonSeeded> {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = (k: TenantKey): string => `${TENANTS[k]}-${run}`;
  await runGraphMigrations(pool);
  const store = (k: TenantKey) => {
    const embedder = processEmbedder();
    return {
      graph: new NeonKnowledgeGraph({ pool, tenantId: tenantId(k) }),
      memory: new InMemoryMemoryStore(),
      processes: new NeonProcessMemoryStore({
        pool,
        tenantId: tenantId(k),
        resolveEmbeddingClient: () => embedder,
      }),
    };
  };
  // Vectors are buffered and written in one statement per tenant: one UPDATE
  // per node was most of the seed's round trips.
  const vectors: Record<TenantKey, Array<[string, string]>> = { main: [], other: [] };
  const seeded = await seedWorld(
    world,
    { main: store('main'), other: store('other') },
    async (k, id, vector) => {
      vectors[k].push([id, `[${vector.join(',')}]`]);
    },
  );
  for (const k of ['main', 'other'] as const) {
    await pool.query(
      `UPDATE graph_nodes AS n SET embedding = v.embedding::vector
         FROM unnest($1::text[], $2::text[]) AS v(external_id, embedding)
        WHERE n.tenant_id = $3 AND n.external_id = v.external_id`,
      [vectors[k].map(([id]) => id), vectors[k].map(([, vec]) => vec), tenantId(k)],
    );
  }
  // A fresh database (CI) has no planner statistics for the rows just
  // written; without them the ACL queries take ~10x longer.
  await pool.query('ANALYZE graph_nodes, graph_edges');
  const clean = async (): Promise<void> => {
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
  };
  return { seeded, clean };
}
