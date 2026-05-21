/**
 * Slice 6.5 — live-DB smoke for PalaiaExcerpt persistence + edit + cascade.
 *
 * Idempotent: cleans the smoke-tenant before and after itself.
 *
 * Verifies (KG-layer; HTTP-route is exercised in the browser):
 *   - createMemorableKnowledge with excerpts persists PalaiaExcerpt
 *     nodes + EXCERPT_OF edges in the same transaction.
 *   - listExcerptsForMemory returns them in position-order.
 *   - updateExcerpt persists text + writes 'edit_excerpt' audit row.
 *   - Hard-cap (>5) and length-cap (>300 chars) reject with typed error.
 *   - Non-owner PATCH attempt → not_an_owner.
 *   - deleteMemory cascade-removes attached excerpts (no orphans).
 */
import 'dotenv/config';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

const TENANT = 'slice-6_5-smoke';

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
      channelUserId: 'slice-6_5-row',
      displayName: 'Slice 6.5 Smoke',
      email: 's6_5@example.com',
      emailVerified: true,
      aadObjectId: 's6_5-aad',
    });
    console.log(`[slice-6_5] seeded user cluster=${cluster.omadiaUserId}`);

    // 1. Create with 3 excerpts
    const created = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'SEO byte5 audit',
      rationale: 'Provenance test',
      createdBy: `web:${cluster.omadiaUserId}`,
      involvedOmadiaUserIds: [cluster.omadiaUserId],
      aclOwners: [cluster.omadiaUserId],
      palaiaExcerpts: {
        texts: [
          'On-Page-Note D (59/100), 6 H1-Tags',
          'fehlende JSON-LD und Canonical-Tags',
          'Bild-URLs auf Staging-Host statt Produktion',
        ],
        source: 'llm',
      },
    });
    const mkId = created.memorableKnowledgeNodeId;
    console.log(`[slice-6_5] created mk=${mkId} with 3 excerpts`);

    // 2. List excerpts
    const listed = await kg.listExcerptsForMemory(mkId);
    if (listed.length !== 3) {
      failures.push(`expected 3 excerpts, got ${listed.length}`);
    } else if (
      listed[0]!.props.position !== 0 ||
      listed[1]!.props.position !== 1 ||
      listed[2]!.props.position !== 2
    ) {
      failures.push(
        `position order broken: [${listed.map((e) => String(e.props.position)).join(', ')}]`,
      );
    } else if (
      listed[0]!.props.text !== 'On-Page-Note D (59/100), 6 H1-Tags' ||
      !listed.every((e) => e.props.source === 'llm')
    ) {
      failures.push('excerpt content / source roundtrip broken');
    } else {
      console.log('[slice-6_5] list-excerpts roundtrip ✓');
    }

    // 3. Update excerpt at position 1 — text + source change
    const updated = await kg.updateExcerpt(
      mkId,
      1,
      { text: 'Canonical-Tags fehlen vollständig', source: 'hint' },
      { actorOmadiaUserId: cluster.omadiaUserId, reason: 'sharper wording' },
    );
    if (
      updated.props.text !== 'Canonical-Tags fehlen vollständig' ||
      updated.props.source !== 'hint' ||
      updated.props.position !== 1
    ) {
      failures.push(
        `update returned wrong shape: ${JSON.stringify(updated.props)}`,
      );
    } else {
      console.log('[slice-6_5] update-excerpt ✓');
    }

    // 4. Audit-log carries an edit_excerpt row with unchanged owners
    const audit = await kg.listMemoryAclAudit(mkId);
    const editExcerptRow = audit.find((r) => r.action === 'edit_excerpt');
    if (!editExcerptRow) {
      failures.push('no edit_excerpt audit row found');
    } else if (
      JSON.stringify(editExcerptRow.beforeOwners) !==
      JSON.stringify(editExcerptRow.afterOwners)
    ) {
      failures.push(
        `edit_excerpt row: beforeOwners must equal afterOwners (got ${JSON.stringify(editExcerptRow.beforeOwners)} vs ${JSON.stringify(editExcerptRow.afterOwners)})`,
      );
    } else if (editExcerptRow.reason !== 'sharper wording') {
      failures.push(
        `edit_excerpt reason mismatch: '${String(editExcerptRow.reason)}'`,
      );
    } else {
      console.log('[slice-6_5] audit edit_excerpt ✓');
    }

    // 5. Hard-cap rejection
    try {
      await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'too many excerpts',
        createdBy: `web:${cluster.omadiaUserId}`,
        involvedOmadiaUserIds: [cluster.omadiaUserId],
        aclOwners: [cluster.omadiaUserId],
        palaiaExcerpts: {
          texts: ['1', '2', '3', '4', '5', '6'],
          source: 'llm',
        },
      });
      failures.push('expected excerpt_count_exceeded');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'excerpt_count_exceeded') {
        failures.push(`expected excerpt_count_exceeded, got '${String(code)}'`);
      } else {
        console.log('[slice-6_5] hard-cap rejection ✓');
      }
    }

    // 6. Length-cap rejection
    try {
      await kg.updateExcerpt(
        mkId,
        0,
        { text: 'x'.repeat(301) },
        { actorOmadiaUserId: cluster.omadiaUserId },
      );
      failures.push('expected excerpt_text_too_long');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'excerpt_text_too_long') {
        failures.push(`expected excerpt_text_too_long, got '${String(code)}'`);
      } else {
        console.log('[slice-6_5] length-cap rejection ✓');
      }
    }

    // 7. Non-owner PATCH blocked
    try {
      await kg.updateExcerpt(
        mkId,
        0,
        { text: 'attempted by non-owner' },
        { actorOmadiaUserId: '00000000-0000-0000-0000-000000000000' },
      );
      failures.push('expected not_an_owner');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'not_an_owner') {
        failures.push(`expected not_an_owner, got '${String(code)}'`);
      } else {
        console.log('[slice-6_5] non-owner blocked ✓');
      }
    }

    // 8. Cascade-delete: deleting the MK removes all excerpts
    await kg.deleteMemory(mkId, { actorOmadiaUserId: cluster.omadiaUserId });
    const orphans = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM graph_nodes
       WHERE tenant_id = $1 AND type = 'PalaiaExcerpt'`,
      [TENANT],
    );
    const remaining = Number(orphans.rows[0]!.count);
    if (remaining !== 0) {
      failures.push(`cascade-delete leaked ${remaining} orphan PalaiaExcerpt nodes`);
    } else {
      console.log('[slice-6_5] cascade-delete ✓');
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
    console.error('\n[slice-6_5] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-6_5] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
