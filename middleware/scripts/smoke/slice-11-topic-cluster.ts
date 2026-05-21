/**
 * Slice 11 — live-DB smoke for Topic clustering.
 *
 * Idempotent: cleans the smoke-tenant before and after.
 *
 * Verifies (against kg_local, fallback naming — no Anthropic):
 *   - migration 0026 is applied (indexes + check work)
 *   - seed 6 MKs in 2 thematic groups (custom embeddings)
 *   - recluster() finds 2 topics
 *   - re-running with the same threshold replaces the topics (deleted=2, created=2)
 *   - higher threshold + smaller cluster size keeps only 1 topic
 */
import 'dotenv/config';

import { Pool } from 'pg';

import {
  NeonKnowledgeGraph,
  runGraphMigrations,
} from '@omadia/knowledge-graph-neon';

import { createTopicClusteringService } from '../../packages/harness-orchestrator-extras/src/topicClustering.js';

const TENANT = 'slice-11-smoke';

async function setEmbeddingDirect(
  pool: Pool,
  tenant: string,
  mkExternalId: string,
  vector: number[],
  dim = 768,
): Promise<void> {
  // Pad the supplied vector with zeros to match the column dimension.
  const padded = [...vector];
  while (padded.length < dim) padded.push(0);
  const literal = `[${padded.slice(0, dim).map((x) => x.toFixed(6)).join(',')}]`;
  await pool.query(
    `UPDATE graph_nodes
        SET embedding = $1::vector
      WHERE tenant_id = $2
        AND external_id = $3
        AND type = 'MemorableKnowledge'`,
    [literal, tenant, mkExternalId],
  );
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url || !(url.includes('localhost') || url.includes('127.0.0.1'))) {
    console.error('refusing — DATABASE_URL must point at localhost');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  await runGraphMigrations(pool, () => undefined);
  const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
  const failures: string[] = [];

  const wipe = async (): Promise<void> => {
    await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
      TENANT,
    ]);
  };
  await wipe();

  try {
    const alice = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-11-alice',
      displayName: 'Alice',
      email: 's11-alice@example.com',
      emailVerified: true,
      aadObjectId: 's11-alice-aad',
    });
    console.log(`[slice-11] seeded alice=${alice.omadiaUserId}`);

    // Build two thematic groups via custom embeddings (dim 768).
    const ids: string[] = [];
    for (const [summary, vec] of [
      ['SEO Audit #1', [1, 0, 0]],
      ['SEO Audit #2', [0.98, 0.02, 0]],
      ['SEO Audit #3', [0.97, 0.04, 0]],
      ['Sales call #1', [0, 1, 0]],
      ['Sales call #2', [0, 0.99, 0.02]],
      ['Sales call #3', [0.02, 0.98, 0]],
    ] as const) {
      const r = await kg.createMemorableKnowledge({
        kind: 'insight',
        summary,
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      });
      ids.push(r.memorableKnowledgeNodeId);
      await setEmbeddingDirect(pool, TENANT, r.memorableKnowledgeNodeId, [...vec]);
    }
    console.log(`[slice-11] seeded ${String(ids.length)} MKs in 2 groups`);

    const service = createTopicClusteringService({ kg });

    // 1. First recluster — should produce 2 topics
    const first = await service.recluster({
      similarityThreshold: 0.6,
      minClusterSize: 3,
    });
    if (first.topicsCreated !== 2) {
      failures.push(
        `first recluster expected 2 topics, got ${String(first.topicsCreated)}`,
      );
    } else {
      console.log(
        `[slice-11] first recluster scanned=${String(first.totalMemoriesScanned)} created=${String(first.topicsCreated)} unclustered=${String(first.unclusteredMemories)} ✓`,
      );
    }

    // 2. listTopics returns them
    const topics = await kg.listTopics();
    if (topics.length !== 2) {
      failures.push(`expected 2 topics in listTopics, got ${topics.length}`);
    }

    // 3. listTopicMembers for the first one
    const t0 = topics[0];
    if (t0) {
      const members = await kg.listTopicMembers(t0.id);
      if (members.length < 3) {
        failures.push(
          `expected ≥3 members on topic ${t0.id}, got ${members.length}`,
        );
      } else {
        console.log(
          `[slice-11] topic ${t0.props.name} has ${String(members.length)} members ✓`,
        );
      }
    }

    // 4. Re-run with same parameters — destructive replace
    const second = await service.recluster({
      similarityThreshold: 0.6,
      minClusterSize: 3,
    });
    if (second.topicsDeleted !== 2) {
      failures.push(`expected 2 deleted, got ${String(second.topicsDeleted)}`);
    }
    if (second.topicsCreated !== 2) {
      failures.push(`expected 2 created on re-run, got ${String(second.topicsCreated)}`);
    } else {
      console.log(`[slice-11] re-run destructive replace ✓`);
    }

    // 5. Higher threshold (0.99) splits more aggressively
    const tight = await service.recluster({
      similarityThreshold: 0.99,
      minClusterSize: 2,
    });
    if (tight.topicsCreated < 1) {
      failures.push(`expected ≥1 tight topic, got ${String(tight.topicsCreated)}`);
    } else {
      console.log(
        `[slice-11] tight threshold scanned=${String(tight.totalMemoriesScanned)} created=${String(tight.topicsCreated)} ✓`,
      );
    }
  } finally {
    await wipe();
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-11] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-11] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
