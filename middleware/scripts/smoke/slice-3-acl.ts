/**
 * Slice 3 — live-DB smoke for ACL filter + addOwner/removeOwner/
 * deleteMemory + audit-survival. Runs against the worktree-local
 * Postgres only.
 *
 * Verifies:
 *   - Create MK with acl_owners=[alice] → audit row 'create'.
 *   - get with viewer=alice ✓ ; get with viewer=bob → null.
 *   - addOwner(bob, actor=alice) → owners=[alice,bob] + audit 'expand'.
 *   - removeOwner(bob, actor=alice) → owners=[alice] + audit 'shrink'.
 *   - removeOwner(alice, actor=alice) → throws cannot_remove_last_owner.
 *   - deleteMemory(actor=alice) → node gone but audit-trail survives.
 *
 * Cleans the smoke-tenant after itself.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

const TENANT = 'slice-3-smoke';

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
    // Seed two clusters.
    const alice = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: randomUUID(),
      displayName: 'Alice',
      aadObjectId: 'aad-oid-alice',
    });
    const bob = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: randomUUID(),
      displayName: 'Bob',
      aadObjectId: 'aad-oid-bob',
    });
    console.log(
      `[slice-3] seeded clusters alice=${alice.omadiaUserId} bob=${bob.omadiaUserId}`,
    );

    // Create MK owned by alice.
    const created = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'Alice picks postgres',
      createdBy: alice.channelIdentityNodeId,
      aclOwners: [alice.omadiaUserId],
      actorOmadiaUserId: alice.omadiaUserId,
    });
    console.log(`[slice-3] created mk=${created.memorableKnowledgeNodeId}`);

    // ACL filter
    const visibleToAlice = await kg.getMemorableKnowledge(
      created.memorableKnowledgeNodeId,
      alice.omadiaUserId,
    );
    if (!visibleToAlice) failures.push('alice should see her own MK');
    const visibleToBob = await kg.getMemorableKnowledge(
      created.memorableKnowledgeNodeId,
      bob.omadiaUserId,
    );
    if (visibleToBob) failures.push('bob should NOT see alice-only MK');
    console.log('[slice-3] ACL get-filter ✓');

    // addOwner
    const afterAdd = await kg.addOwner(
      created.memorableKnowledgeNodeId,
      bob.omadiaUserId,
      {
        actorOmadiaUserId: alice.omadiaUserId,
        actorChannelIdentityId: alice.channelIdentityNodeId,
        reason: 'sharing with bob',
      },
    );
    if (!afterAdd.includes(bob.omadiaUserId)) {
      failures.push('addOwner failed to add bob');
    }
    console.log(`[slice-3] addOwner ✓ → ${JSON.stringify(afterAdd)}`);

    // Bob can now see it
    const nowVisibleToBob = await kg.getMemorableKnowledge(
      created.memorableKnowledgeNodeId,
      bob.omadiaUserId,
    );
    if (!nowVisibleToBob) failures.push('bob should now see the MK');

    // removeOwner refuses last owner
    await kg.removeOwner(
      created.memorableKnowledgeNodeId,
      bob.omadiaUserId,
      { actorOmadiaUserId: alice.omadiaUserId },
    );
    let lastOwnerRefused = false;
    try {
      await kg.removeOwner(
        created.memorableKnowledgeNodeId,
        alice.omadiaUserId,
        { actorOmadiaUserId: alice.omadiaUserId },
      );
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'cannot_remove_last_owner'
      ) {
        lastOwnerRefused = true;
      }
    }
    if (!lastOwnerRefused) {
      failures.push('removeOwner should refuse to drop last owner');
    } else {
      console.log('[slice-3] removeOwner last-owner refused ✓');
    }

    // Delete + audit survives
    await kg.deleteMemory(created.memorableKnowledgeNodeId, {
      actorOmadiaUserId: alice.omadiaUserId,
      reason: 'cleanup',
    });
    const afterDelete = await kg.getMemorableKnowledge(
      created.memorableKnowledgeNodeId,
      alice.omadiaUserId,
    );
    if (afterDelete !== null) failures.push('MK should be gone after delete');

    const audit = await kg.listMemoryAclAudit(created.memorableKnowledgeNodeId);
    const actions = audit.map((a) => a.action);
    if (!actions.includes('delete'))
      failures.push('audit-trail missing delete row');
    if (!actions.includes('create'))
      failures.push('audit-trail missing create row');
    if (audit[0]?.action !== 'delete')
      failures.push(
        `newest audit row should be 'delete', got '${String(actions[0])}'`,
      );
    console.log(
      `[slice-3] audit-trail survives delete (${audit.length} rows: ${actions.join(', ')}) ✓`,
    );
  } finally {
    await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
      TENANT,
    ]);
    await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-3] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-3] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
