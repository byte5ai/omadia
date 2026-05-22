/**
 * Slice 5 — live-DB smoke for updateMemorableKnowledge (PATCH).
 *
 * Idempotent: cleans the smoke-tenant before and after itself.
 *
 * Verifies:
 *   - PATCH applies kind + summary changes and re-reads via getter.
 *   - PATCH with rationale=null removes the rationale property.
 *   - Empty patch throws code='empty_patch'.
 *   - Each accepted PATCH writes an 'edit' audit row with
 *     beforeOwners === afterOwners.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

const TENANT = 'slice-5-smoke';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url || !(url.includes('localhost') || url.includes('127.0.0.1'))) {
    console.error('refusing — DATABASE_URL must point at localhost');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
  const failures: string[] = [];

  await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
    TENANT,
  ]);

  try {
    const cluster = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-5-row',
      displayName: 'Slice 5 Smoke',
      email: 's5@example.com',
      emailVerified: true,
      aadObjectId: 's5-aad',
    });
    console.log(`[slice-5] seeded user cluster=${cluster.omadiaUserId}`);

    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'Original summary',
      rationale: 'Original rationale',
      createdBy: `web:${cluster.omadiaUserId}`,
      involvedOmadiaUserIds: [cluster.omadiaUserId],
      aclOwners: [cluster.omadiaUserId],
    });
    const mkId = created.memorableKnowledgeNodeId;
    console.log(`[slice-5] created mk=${mkId}`);

    // 1. PATCH kind + summary
    const patched = await kg.updateMemorableKnowledge(
      mkId,
      { kind: 'decision', summary: 'Patched summary' },
      { actorOmadiaUserId: cluster.omadiaUserId, reason: 'fixing classification' },
    );
    if (patched.props['kind'] !== 'decision') {
      failures.push(
        `expected kind=decision, got ${String(patched.props['kind'])}`,
      );
    }
    if (patched.props['summary'] !== 'Patched summary') {
      failures.push(
        `expected summary='Patched summary', got ${String(patched.props['summary'])}`,
      );
    }
    if (patched.props['rationale'] !== 'Original rationale') {
      failures.push(
        `untouched rationale should survive, got ${String(patched.props['rationale'])}`,
      );
    }
    console.log('[slice-5] PATCH kind+summary ✓');

    // 2. PATCH rationale=null removes the field
    const patched2 = await kg.updateMemorableKnowledge(
      mkId,
      { rationale: null },
      { actorOmadiaUserId: cluster.omadiaUserId },
    );
    if (patched2.props['rationale'] !== undefined) {
      failures.push(
        `expected rationale=undefined after null-patch, got ${String(patched2.props['rationale'])}`,
      );
    }
    console.log('[slice-5] PATCH rationale=null ✓');

    // 3. Empty patch rejected
    try {
      await kg.updateMemorableKnowledge(
        mkId,
        {},
        { actorOmadiaUserId: cluster.omadiaUserId },
      );
      failures.push('empty patch should throw');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'empty_patch') {
        failures.push(`expected empty_patch, got ${String(code)}`);
      } else {
        console.log('[slice-5] empty-patch rejected ✓');
      }
    }

    // 4. Non-owner blocked
    try {
      await kg.updateMemorableKnowledge(
        mkId,
        { summary: 'should fail' },
        {
          actorOmadiaUserId: '00000000-0000-0000-0000-000000000000',
        },
      );
      failures.push('non-owner patch should throw not_an_owner');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'not_an_owner') {
        failures.push(`expected not_an_owner, got ${String(code)}`);
      } else {
        console.log('[slice-5] non-owner blocked ✓');
      }
    }

    // 5. Audit-log carries 'edit' rows with unchanged owners
    const audit = await kg.listMemoryAclAudit(mkId);
    const editRows = audit.filter((r) => r.action === 'edit');
    if (editRows.length !== 2) {
      failures.push(
        `expected 2 edit audit rows, got ${editRows.length}`,
      );
    } else if (
      !editRows.every(
        (r) =>
          Array.isArray(r.beforeOwners) &&
          Array.isArray(r.afterOwners) &&
          JSON.stringify(r.beforeOwners) === JSON.stringify(r.afterOwners),
      )
    ) {
      failures.push('edit audit rows: beforeOwners must equal afterOwners');
    } else {
      console.log(`[slice-5] audit edit-rows=${editRows.length} ✓`);
    }
  } finally {
    await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
      TENANT,
    ]);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-5] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-5] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
