import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/embeddings';
import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

// OB-81 — `CaptureDisclosure.embedded` reads `embeddingScheduled` off the ingest
// result. Only the Neon backend embeds, so only it can set the flag: it has to
// mirror the decision that really starts the embedder.

const TENANT = 'capture-disclosure-embedding';

const embedder: EmbeddingClient = {
  dimensions: 768,
  modelId: 'test:embedder',
  embed: () => Promise.resolve(new Array<number>(768).fill(0.1)),
} as unknown as EmbeddingClient;

let seq = 0;
const nextTurn = (): { scope: string; time: string; userMessage: string; assistantAnswer: string; toolCalls: number; iterations: number; entityRefs: [] } => ({
  scope: `scope-${String(Date.now())}-${String((seq += 1))}`,
  time: new Date().toISOString(),
  userMessage: 'Frage',
  assistantAnswer: 'Antwort',
  toolCalls: 0,
  iterations: 1,
  entityRefs: [],
});

describe('NeonKnowledgeGraph.ingestTurn embeddingScheduled', () => {
  let pool: Pool | undefined;

  before(async () => {
    const probe = await probePgTest({
      label: 'captureDisclosureNeonEmbedding',
      vars: ['WS3_PG_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    await runGraphMigrations(pool);
  });

  after(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it('is set when the embedder starts, absent when it does not', async (t) => {
    if (!pool) {
      t.skip('no reachable pgvector Postgres');
      return;
    }
    const withClient = new NeonKnowledgeGraph({
      pool,
      tenantId: TENANT,
      resolveEmbeddingClient: () => embedder,
    });
    assert.equal((await withClient.ingestTurn(nextTurn())).embeddingScheduled, true);
    assert.equal(
      (await withClient.ingestTurn({ ...nextTurn(), tailOnly: true })).embeddingScheduled,
      undefined,
      'a tail-only turn is never embedded',
    );

    const withoutClient = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
    assert.equal((await withoutClient.ingestTurn(nextTurn())).embeddingScheduled, undefined);
  });
});
