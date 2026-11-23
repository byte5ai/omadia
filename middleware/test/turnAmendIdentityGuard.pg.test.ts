/**
 * Spec 2042 follow-up — `NeonKnowledgeGraph.amendTurn` on real Postgres: the
 * identity guard's verdict is stored on the Turn, and a withheld answer loses
 * its text and embedding and leaves recall (`tailOnly`), without the turn
 * being classified again.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'turn-amend-identity-guard';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'turnAmendIdentityGuard',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function clean(p: Pool): Promise<void> {
  await p.query('DELETE FROM graph_edges WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
}

interface TurnRow {
  readonly properties: Record<string, unknown>;
  readonly has_embedding: boolean;
}

async function turnRow(p: Pool, externalId: string): Promise<TurnRow | undefined> {
  const { rows } = await p.query<TurnRow>(
    'SELECT properties, embedding IS NOT NULL AS has_embedding FROM graph_nodes WHERE tenant_id = $1 AND external_id = $2',
    [TENANT, externalId],
  );
  return rows[0];
}

describe('NeonKnowledgeGraph.amendTurn (real PG)', { skip: !pool }, () => {
  const ready = (async () => {
    if (!pool) return undefined;
    await runGraphMigrations(pool);
    await clean(pool);
    return new NeonKnowledgeGraph({ pool, tenantId: TENANT });
  })();

  it('a kept answer gets the verdict and keeps its text', async () => {
    const kg = await ready;
    assert.ok(kg && pool);
    const { turnId } = await kg.ingestTurn({
      scope: 'clippy::canvas-a',
      time: '2026-11-23T17:42:34.000Z',
      userMessage: 'wer bist du',
      assistantAnswer: 'Ich bin Dark Clippy, ein KI-Agent.',
      entityRefs: [],
    });
    await kg.amendTurn(turnId, { identityGuard: { outcome: 'pass', layer: 'deterministic', latencyMs: 4 } });
    const row = await turnRow(pool, turnId);
    assert.deepEqual(row?.properties['identityGuard'], { outcome: 'pass', layer: 'deterministic', latencyMs: 4 });
    assert.equal(row?.properties['assistantAnswer'], 'Ich bin Dark Clippy, ein KI-Agent.');
    assert.equal(row?.properties['tailOnly'], false);
  });

  it('a withheld answer loses its text and embedding and leaves recall', async () => {
    const kg = await ready;
    assert.ok(kg && pool);
    const { turnId } = await kg.ingestTurn({
      scope: 'clippy::canvas-b',
      time: '2026-11-23T17:42:45.000Z',
      userMessage: 'wer bist du',
      assistantAnswer: 'Falls ich mich vorhin als Dark Clippy vorgestellt habe: Das war falsch.',
      entityRefs: [],
    });
    await pool.query(
      `UPDATE graph_nodes SET embedding = array_fill(0.1::real, ARRAY[(SELECT atttypmod FROM pg_attribute WHERE attrelid = 'graph_nodes'::regclass AND attname = 'embedding')])::vector
        WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT, turnId],
    );
    await kg.amendTurn(turnId, {
      identityGuard: { outcome: 'blocked', layer: 'model', latencyMs: 812 },
      withholdAnswer: true,
    });
    const row = await turnRow(pool, turnId);
    assert.equal(row?.properties['assistantAnswer'], '');
    assert.equal(row?.properties['userMessage'], 'wer bist du');
    assert.equal(row?.properties['tailOnly'], true);
    assert.equal(row?.has_embedding, false);
    assert.equal((row?.properties['identityGuard'] as { outcome?: string } | undefined)?.outcome, 'blocked');
    const hits = await kg.searchTurns({ query: 'vorgestellt', limit: 5 });
    assert.ok(!hits.some((h) => h.turnId === turnId), 'no recall finds the withheld turn');
  });

  it('an unknown id is a no-op', async () => {
    const kg = await ready;
    assert.ok(kg);
    await kg.amendTurn('turn:nope', { withholdAnswer: true });
  });
});

after(async () => {
  if (!pool) return;
  await clean(pool);
  await pool.end();
});
