/**
 * Slice 2 — live-DB smoke for MemorableKnowledge create + list cycle.
 * Runs against the worktree-local Postgres only (foot-gun guard).
 *
 * Verifies:
 *   - Seed a User-Cluster via resolveOrCreateChannelIdentity.
 *   - createMemorableKnowledge round-trips the node + INVOLVED edge.
 *   - listMemorableKnowledgeFor surfaces the new MK.
 *   - Kind filter narrows the result.
 *   - DB row carries the partial-index target shape (kind property
 *     present on the node).
 *
 * Cleans the smoke-tenant after itself.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

const TENANT = 'slice-2-smoke';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url || !(url.includes('localhost') || url.includes('127.0.0.1'))) {
    console.error('refusing — DATABASE_URL must point at localhost');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
  const failures: string[] = [];

  try {
    const cluster = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'smoke-row-uuid-1',
      displayName: 'Slice 2 Smoke',
      email: 'smoke@example.com',
      emailVerified: true,
      aadObjectId: 'smoke-aad-oid',
    });
    console.log(`[slice-2] seeded user cluster=${cluster.omadiaUserId}`);

    const created = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'Adopted MemorableKnowledge as the curated memory layer.',
      rationale: 'Slice 3 gates listMemorableKnowledgeFor on acl_owners.',
      significance: 0.87,
      createdBy: cluster.channelIdentityNodeId,
      involvedOmadiaUserIds: [cluster.omadiaUserId],
      aclOwners: [cluster.omadiaUserId],
    });
    console.log(`[slice-2] created mk=${created.memorableKnowledgeNodeId}`);
    if (created.skippedInvolved !== 0) {
      failures.push(
        `expected skippedInvolved=0, got ${created.skippedInvolved}`,
      );
    }

    const fetched = await kg.getMemorableKnowledge(
      created.memorableKnowledgeNodeId,
    );
    if (!fetched) failures.push('getMemorableKnowledge returned null');
    if (fetched?.type !== 'MemorableKnowledge') {
      failures.push(`unexpected node type ${String(fetched?.type)}`);
    }
    if (fetched?.props['kind'] !== 'decision') {
      failures.push(`unexpected kind ${String(fetched?.props['kind'])}`);
    }
    console.log(`[slice-2] getMemorableKnowledge ✓`);

    const list = await kg.listMemorableKnowledgeFor(cluster.omadiaUserId);
    if (list.length !== 1) {
      failures.push(`expected 1 MK for user, got ${list.length}`);
    }
    if (list[0]?.id !== created.memorableKnowledgeNodeId) {
      failures.push(
        `list returned wrong MK: ${String(list[0]?.id)} vs ${created.memorableKnowledgeNodeId}`,
      );
    }
    console.log(`[slice-2] listMemorableKnowledgeFor ✓`);

    const insights = await kg.listMemorableKnowledgeFor(cluster.omadiaUserId, {
      kind: 'insight',
    });
    if (insights.length !== 0) {
      failures.push(`expected 0 insights, got ${insights.length}`);
    }
    console.log(`[slice-2] kind-filter ✓`);
  } finally {
    await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-2] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-2] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
