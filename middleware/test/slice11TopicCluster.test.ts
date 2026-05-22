import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  TOPIC_NAMING_SOURCES,
  validateNodeProps,
} from '@omadia/knowledge-graph-neon';

import { createTopicClusteringService } from '../packages/harness-orchestrator-extras/src/topicClustering.js';

/**
 * Slice 11 — Topic clustering over MK embeddings.
 *
 * Coverage (DB-less via InMemory):
 *   1. Migration 0023 (sic 0024) SQL declares HAS_TOPIC indexes + name CHECK.
 *   2. Schema enums + Zod validate the new Topic node.
 *   3. KG round-trips: create / list / getWithMembers / delete-all.
 *   4. Clustering: separate-thematic-groups → two Topics. Singletons stay
 *      unclustered. Re-cluster is destructive + idempotent in shape.
 *   5. Fallback naming when no Anthropic client wired.
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

const ALICE = '11111111-1111-1111-1111-111111111111';

async function seed(
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

async function makeMK(
  kg: InMemoryKnowledgeGraph,
  owner: string,
  summary: string,
  embedding: number[],
): Promise<string> {
  const r = await kg.createMemorableKnowledge({
    kind: 'insight',
    summary,
    createdBy: `web:${owner}`,
    involvedOmadiaUserIds: [owner],
    aclOwners: [owner],
  });
  kg.setEmbedding(r.memorableKnowledgeNodeId, embedding);
  return r.memorableKnowledgeNodeId;
}

describe('Slice 11 · migration 0026 SQL', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0026_topic.sql'),
      'utf8',
    );
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });
  it('declares HAS_TOPIC indexes', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0026_topic.sql'),
      'utf8',
    );
    assert.match(sql, /graph_edges_has_topic_idx/);
    assert.match(sql, /graph_edges_has_topic_from_idx/);
    assert.match(sql, /WHERE type = 'HAS_TOPIC'/);
  });
  it('declares Topic name CHECK', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0026_topic.sql'),
      'utf8',
    );
    assert.match(sql, /graph_nodes_topic_name_chk/);
    assert.match(sql, /length\(properties->>'name'\)/);
  });
});

describe('Slice 11 · enums + Zod', () => {
  it('GRAPH_NODE_TYPES contains Topic', () => {
    assert.ok(GRAPH_NODE_TYPES.includes('Topic'));
  });
  it('GRAPH_EDGE_TYPES contains HAS_TOPIC', () => {
    assert.ok(GRAPH_EDGE_TYPES.includes('HAS_TOPIC'));
  });
  it('exports TOPIC_NAMING_SOURCES', () => {
    assert.deepEqual([...TOPIC_NAMING_SOURCES], ['haiku', 'fallback']);
  });
  it('validateNodeProps accepts well-formed Topic', () => {
    const out = validateNodeProps('Topic', {
      name: 'byte5 SEO',
      description: 'SEO-related memories',
      member_count: 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      naming_source: 'haiku',
    });
    assert.equal(out['name'], 'byte5 SEO');
  });
  it('validateNodeProps rejects too-long name', () => {
    assert.throws(() =>
      validateNodeProps('Topic', {
        name: 'x'.repeat(250),
        description: '',
        member_count: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        naming_source: 'fallback',
      }),
    );
  });
});

describe('Slice 11 · KG round-trips', () => {
  it('createTopic + listTopics + listTopicMembers + delete', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    const mkA = await makeMK(kg, owner, 'A', [1, 0, 0]);
    const mkB = await makeMK(kg, owner, 'B', [0.99, 0.01, 0]);
    const topic = await kg.createTopic({
      name: 'Test Topic',
      description: 'desc',
      namingSource: 'fallback',
      memberMkIds: [mkA, mkB],
    });
    assert.equal(topic.props.member_count, 2);
    const list = await kg.listTopics();
    assert.equal(list.length, 1);
    const members = await kg.listTopicMembers(topic.id);
    assert.equal(members.length, 2);
    const got = await kg.getTopic(topic.id);
    assert.ok(got);
    const deleted = await kg.deleteAllTopics();
    assert.equal(deleted, 1);
    const afterList = await kg.listTopics();
    assert.equal(afterList.length, 0);
  });
});

describe('Slice 11 · clustering service', () => {
  it('finds two separated clusters and one singleton', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    // Group 1: cosine ≈ 1.0 to each other
    await makeMK(kg, owner, 'SEO 1', [1, 0, 0, 0]);
    await makeMK(kg, owner, 'SEO 2', [0.98, 0.02, 0, 0]);
    await makeMK(kg, owner, 'SEO 3', [0.97, 0.05, 0, 0]);
    // Group 2: orthogonal direction
    await makeMK(kg, owner, 'Sales 1', [0, 1, 0, 0]);
    await makeMK(kg, owner, 'Sales 2', [0, 0.99, 0.05, 0]);
    await makeMK(kg, owner, 'Sales 3', [0.02, 0.98, 0, 0]);
    // Lone outlier
    await makeMK(kg, owner, 'Outlier', [0, 0, 0, 1]);

    const service = createTopicClusteringService({ kg });
    const result = await service.recluster({
      similarityThreshold: 0.6,
      minClusterSize: 3,
    });
    assert.equal(result.totalMemoriesScanned, 7);
    assert.equal(result.topicsCreated, 2);
    assert.equal(result.unclusteredMemories, 1);
    assert.equal(result.haikuCalls, 0); // no anthropic dep → fallback names

    const topics = await service.list();
    assert.equal(topics.length, 2);
    for (const t of topics) {
      assert.equal(t.props.naming_source, 'fallback');
      assert.ok(t.props.member_count >= 3);
    }
  });
  it('singletons stay unclustered', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    await makeMK(kg, owner, 'A', [1, 0]);
    await makeMK(kg, owner, 'B', [0, 1]);
    const service = createTopicClusteringService({ kg });
    const result = await service.recluster({
      similarityThreshold: 0.5,
      minClusterSize: 3,
    });
    assert.equal(result.topicsCreated, 0);
    assert.equal(result.unclusteredMemories, 2);
  });
  it('re-cluster is destructive (deletes old + rebuilds)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    await makeMK(kg, owner, 'A', [1, 0, 0]);
    await makeMK(kg, owner, 'B', [0.97, 0.02, 0]);
    await makeMK(kg, owner, 'C', [0.95, 0.05, 0]);
    const service = createTopicClusteringService({ kg });
    const first = await service.recluster({
      similarityThreshold: 0.6,
      minClusterSize: 3,
    });
    assert.equal(first.topicsCreated, 1);
    assert.equal(first.topicsDeleted, 0);
    const second = await service.recluster({
      similarityThreshold: 0.6,
      minClusterSize: 3,
    });
    assert.equal(second.topicsDeleted, 1);
    assert.equal(second.topicsCreated, 1);
  });
  it('higher threshold rebuilds with at-most as-many clusters', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seed(kg, ALICE, 'alice@example.com');
    // Two tight clusters with a noisy bridge: A-B-C at one direction,
    // D-E-F at another, plus a deliberate bridge G that's roughly
    // between them.
    await makeMK(kg, owner, 'A', [1, 0]);
    await makeMK(kg, owner, 'B', [0.99, 0.01]);
    await makeMK(kg, owner, 'C', [0.98, 0.02]);
    await makeMK(kg, owner, 'D', [0.6, 0.8]);
    await makeMK(kg, owner, 'E', [0.5, 0.85]);
    await makeMK(kg, owner, 'F', [0.4, 0.9]);
    await makeMK(kg, owner, 'G-bridge', [0.85, 0.5]);
    const service = createTopicClusteringService({ kg });
    // At loose threshold the bridge connects both — likely one big cluster.
    const loose = await service.recluster({
      similarityThreshold: 0.5,
      minClusterSize: 2,
    });
    // At tight threshold the bridge breaks; the two tight groups
    // split. The bridge node ends up unclustered (singleton).
    const tight = await service.recluster({
      similarityThreshold: 0.95,
      minClusterSize: 2,
    });
    assert.ok(loose.topicsCreated <= tight.topicsCreated);
    assert.equal(tight.topicsCreated, 2);
    assert.equal(tight.unclusteredMemories, 1);
  });
});
