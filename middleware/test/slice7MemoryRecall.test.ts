import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

/**
 * Slice 7 — semantic recall over MemorableKnowledge + PalaiaExcerpt.
 *
 * Backend-side coverage:
 *   1. Migration 0022 declares the per-type backfill-pending indexes.
 *   2. InMemory KG round-trips: create + setEmbedding → searchByEmbedding
 *      surfaces the MK; ACL gate isolates non-owners; excerpt-search
 *      JOINs back to parent for ACL; updateMK / updateExcerpt clear the
 *      stale embedding so search loses the row until the (real) backfill
 *      re-embeds it; deleteMemory cascade-purges embeddings.
 *
 * Production behaviour (sync embed in `createMemorableKnowledge`,
 * fire-and-forget post-COMMIT against Ollama, generalized backfill
 * sweep) lives in `slice-7-memory-recall.ts` smoke against kg_local.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
);

describe('Slice 7 · migration 0022 SQL file', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0022_kg_embedding_pending_indexes.sql'),
      'utf8',
    );
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });
  it('declares the MK backfill-pending partial index', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0022_kg_embedding_pending_indexes.sql'),
      'utf8',
    );
    assert.match(sql, /idx_graph_nodes_mk_embedding_pending/);
    assert.match(sql, /WHERE type = 'MemorableKnowledge' AND embedding IS NULL/);
  });
  it('declares the PalaiaExcerpt backfill-pending partial index', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0022_kg_embedding_pending_indexes.sql'),
      'utf8',
    );
    assert.match(sql, /idx_graph_nodes_excerpt_embedding_pending/);
    assert.match(sql, /WHERE type = 'PalaiaExcerpt' AND embedding IS NULL/);
  });
});

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';

async function seedCluster(
  kg: InMemoryKnowledgeGraph,
  uuid: string,
  email: string,
): Promise<string> {
  const cluster = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: uuid,
    displayName: email,
    email,
    emailVerified: true,
  });
  return cluster.omadiaUserId;
}

/** Direction-aligned vectors so cosine ≈ 1; anti-aligned for ≈ -1.  */
const VEC_A = [1, 0, 0, 0];
const VEC_A_NEAR = [0.95, 0.05, 0, 0];
const VEC_B = [0, 1, 0, 0];

describe('Slice 7 · MK semantic search', () => {
  it('surfaces a MK whose embedding cosine-matches the query', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedCluster(kg, ALICE, 'alice@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'matchable',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
    });
    kg.setEmbedding(created.memorableKnowledgeNodeId, VEC_A);

    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: VEC_A_NEAR,
      viewerOmadiaUserId: owner,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.mk.id, created.memorableKnowledgeNodeId);
    assert.ok(hits[0]!.cosineSim > 0.9);
  });

  it('returns [] when no MK has an embedding', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedCluster(kg, ALICE, 'alice@example.com');
    await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'never embedded',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
    });
    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: owner,
    });
    assert.equal(hits.length, 0);
  });

  it('ACL: viewer who is not in acl_owners sees nothing', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const alice = await seedCluster(kg, ALICE, 'alice@example.com');
    const bob = await seedCluster(kg, BOB, 'bob@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'private to alice',
      createdBy: `web:${alice}`,
      involvedOmadiaUserIds: [alice],
      aclOwners: [alice],
    });
    kg.setEmbedding(created.memorableKnowledgeNodeId, VEC_A);
    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: bob,
    });
    assert.equal(hits.length, 0);
  });

  it('drops hits below minSimilarity', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedCluster(kg, ALICE, 'alice@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'orthogonal',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
    });
    kg.setEmbedding(created.memorableKnowledgeNodeId, VEC_B);
    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: owner,
      minSimilarity: 0.3,
    });
    assert.equal(hits.length, 0); // cosine(VEC_A, VEC_B) = 0
  });

  it('updateMemorableKnowledge clears the stale embedding', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedCluster(kg, ALICE, 'alice@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'before edit',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
    });
    kg.setEmbedding(created.memorableKnowledgeNodeId, VEC_A);
    await kg.updateMemorableKnowledge(
      created.memorableKnowledgeNodeId,
      { summary: 'after edit' },
      { actorOmadiaUserId: owner },
    );
    const hits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: owner,
    });
    assert.equal(hits.length, 0);
  });
});

describe('Slice 7 · Excerpt semantic search', () => {
  it('surfaces an excerpt + its parent MK id', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedCluster(kg, ALICE, 'alice@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'with excerpts',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['quote one', 'quote two'], source: 'llm' },
    });
    const excerpts = await kg.listExcerptsForMemory(
      created.memorableKnowledgeNodeId,
    );
    assert.equal(excerpts.length, 2);
    kg.setEmbedding(excerpts[0]!.id, VEC_A);

    const hits = await kg.searchExcerptsByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: owner,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.parentMkId, created.memorableKnowledgeNodeId);
    assert.equal(hits[0]!.excerpt.props.text, 'quote one');
  });

  it('ACL: excerpt of an MK whose parent excludes the viewer is hidden', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const alice = await seedCluster(kg, ALICE, 'alice@example.com');
    const bob = await seedCluster(kg, BOB, 'bob@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'private',
      createdBy: `web:${alice}`,
      involvedOmadiaUserIds: [alice],
      aclOwners: [alice],
      palaiaExcerpts: { texts: ['secret quote'], source: 'llm' },
    });
    const excerpts = await kg.listExcerptsForMemory(
      created.memorableKnowledgeNodeId,
    );
    kg.setEmbedding(excerpts[0]!.id, VEC_A);

    const hits = await kg.searchExcerptsByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: bob,
    });
    assert.equal(hits.length, 0);
  });

  it('updateExcerpt clears its embedding', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedCluster(kg, ALICE, 'alice@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'patchable excerpts',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['original'], source: 'llm' },
    });
    const excerpts = await kg.listExcerptsForMemory(
      created.memorableKnowledgeNodeId,
    );
    kg.setEmbedding(excerpts[0]!.id, VEC_A);
    await kg.updateExcerpt(
      created.memorableKnowledgeNodeId,
      0,
      { text: 'edited' },
      { actorOmadiaUserId: owner },
    );
    const hits = await kg.searchExcerptsByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: owner,
    });
    assert.equal(hits.length, 0);
  });

  it('deleteMemory cascade-purges excerpt embeddings', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedCluster(kg, ALICE, 'alice@example.com');
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'doomed',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['will-be-gone'], source: 'llm' },
    });
    const excerpts = await kg.listExcerptsForMemory(
      created.memorableKnowledgeNodeId,
    );
    kg.setEmbedding(created.memorableKnowledgeNodeId, VEC_A);
    kg.setEmbedding(excerpts[0]!.id, VEC_A);
    await kg.deleteMemory(created.memorableKnowledgeNodeId, {
      actorOmadiaUserId: owner,
    });
    const mkHits = await kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: owner,
    });
    const excerptHits = await kg.searchExcerptsByEmbedding({
      queryEmbedding: VEC_A,
      viewerOmadiaUserId: owner,
    });
    assert.equal(mkHits.length, 0);
    assert.equal(excerptHits.length, 0);
  });
});
