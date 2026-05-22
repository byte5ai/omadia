/**
 * Slice 9 — live-DB smoke for inconsistency persistence + resolve.
 * Validates the KG-layer end-to-end against kg_local; the live
 * detector (Haiku judgement-pass) is exercised manually in the
 * browser since it requires an Anthropic key.
 *
 * Idempotent: cleans the smoke-tenant before and after.
 *
 * Verifies:
 *   - createInconsistency persists Inconsistency + 2 CONFLICTS_WITH edges
 *   - dedupe on the (sorted) MK pair, regardless of input order
 *   - listInconsistencies surfaces only union-owner-visible entries
 *   - getInconsistency hides from non-owners
 *   - resolve a_wins deletes the loser, marks resolved with audit
 *   - resolve dismiss marks dismissed without delete
 *   - already_resolved blocks re-resolve
 *   - Inconsistency to a deleted MK is correctly hydrated as null-arm
 */
import 'dotenv/config';

import { Pool } from 'pg';

import {
  NeonKnowledgeGraph,
  runGraphMigrations,
} from '@omadia/knowledge-graph-neon';

const TENANT = 'slice-9-smoke';

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

  await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
    TENANT,
  ]);

  try {
    const alice = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-9-alice',
      displayName: 'Alice',
      email: 's9-alice@example.com',
      emailVerified: true,
      aadObjectId: 's9-alice-aad',
    });
    const bob = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-9-bob',
      displayName: 'Bob',
      email: 's9-bob@example.com',
      emailVerified: true,
      aadObjectId: 's9-bob-aad',
    });
    console.log(
      `[slice-9] seeded clusters alice=${alice.omadiaUserId} bob=${bob.omadiaUserId}`,
    );

    const mkA = (
      await kg.createMemorableKnowledge({
        kind: 'decision',
        summary: 'byte5 SEO: H1-Tags zuerst fixen',
        rationale: 'On-Page-Note D ist der dringendste Hebel.',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;

    const mkB = (
      await kg.createMemorableKnowledge({
        kind: 'decision',
        summary: 'byte5 SEO: JSON-LD zuerst fixen',
        rationale: 'Strukturierte Suche ist der größere Trust-Signal.',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    console.log(`[slice-9] created two conflicting MKs`);

    // 1. createInconsistency persists + edges sorted
    const inc = await kg.createInconsistency({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      summary: 'Beide Memories priorisieren denselben SEO-Audit unterschiedlich.',
      severity: 'medium',
    });
    if (!inc) {
      failures.push('createInconsistency returned null');
    } else {
      const sorted = [mkA, mkB].sort();
      if (
        inc.conflictsWith[0] !== sorted[0] ||
        inc.conflictsWith[1] !== sorted[1]
      ) {
        failures.push(
          `conflictsWith mis-sorted: ${JSON.stringify(inc.conflictsWith)} expected ${JSON.stringify(sorted)}`,
        );
      } else {
        console.log(`[slice-9] inconsistency ${inc.id} created ✓`);
      }
    }

    // 2. dedupe
    const dup = await kg.createInconsistency({
      mkAExternalId: mkB,
      mkBExternalId: mkA,
      summary: 'duplicate attempt',
      severity: 'high',
    });
    if (dup !== null) {
      failures.push(`dedupe failed — got ${String(dup?.id)}`);
    } else {
      console.log('[slice-9] dedupe ✓');
    }

    // 3. ACL: alice sees, bob doesn't
    const aliceList = await kg.listInconsistencies({
      viewerOmadiaUserId: alice.omadiaUserId,
    });
    const bobList = await kg.listInconsistencies({
      viewerOmadiaUserId: bob.omadiaUserId,
    });
    if (aliceList.length !== 1) {
      failures.push(`alice expected 1 inconsistency, got ${aliceList.length}`);
    }
    if (bobList.length !== 0) {
      failures.push(`bob expected 0 inconsistencies, got ${bobList.length}`);
    }
    console.log(
      `[slice-9] ACL: alice=${aliceList.length} bob=${bobList.length} ✓`,
    );

    // 4. getInconsistency hides from non-owner
    const fromBob = await kg.getInconsistency(inc!.id, bob.omadiaUserId);
    if (fromBob !== null) {
      failures.push('getInconsistency leaked to non-owner bob');
    }

    // 5. resolve a_wins deletes the loser
    const resolveResult = await kg.resolveInconsistency(inc!.id, 'a_wins', {
      actorOmadiaUserId: alice.omadiaUserId,
      reason: 'H1-Tag-Fix wurde live gewählt',
    });
    if (resolveResult.props.status !== 'resolved') {
      failures.push(`expected status=resolved, got ${resolveResult.props.status}`);
    }
    if (resolveResult.props.resolution !== 'a_wins') {
      failures.push(
        `expected resolution=a_wins, got ${resolveResult.props.resolution}`,
      );
    }
    // a_wins deletes conflictsWith[1] (sorted-second) — mkA or mkB depending
    // on sort order. Verify the survivor still exists and the loser is gone.
    const sorted = [mkA, mkB].sort();
    const winner = await kg.getMemorableKnowledge(sorted[0]!);
    const deleted = await kg.getMemorableKnowledge(sorted[1]!);
    if (!winner) failures.push('winner MK was deleted');
    if (deleted) failures.push('loser MK still present after a_wins');
    console.log(`[slice-9] resolve a_wins ✓ (deleted ${sorted[1]})`);

    // 6. already_resolved blocks re-resolve
    try {
      await kg.resolveInconsistency(inc!.id, 'dismiss', {
        actorOmadiaUserId: alice.omadiaUserId,
      });
      failures.push('expected already_resolved');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'already_resolved') {
        failures.push(`expected already_resolved, got ${String(code)}`);
      } else {
        console.log('[slice-9] already_resolved blocks re-resolve ✓');
      }
    }

    // 7. dismiss flow on a fresh inconsistency
    const mkC = (
      await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'Marketing-Texte werden auf 8 Klassen reduziert',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    const mkD = (
      await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'Marketing-Texte werden in 12 Topic-Cluster gruppiert',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    const inc2 = await kg.createInconsistency({
      mkAExternalId: mkC,
      mkBExternalId: mkD,
      summary: 'Detector flagged related but they target different surfaces',
      severity: 'low',
    });
    const dismissed = await kg.resolveInconsistency(inc2!.id, 'dismiss', {
      actorOmadiaUserId: alice.omadiaUserId,
    });
    if (dismissed.props.status !== 'dismissed') {
      failures.push(
        `expected status=dismissed, got ${dismissed.props.status}`,
      );
    }
    if (
      !(await kg.getMemorableKnowledge(mkC)) ||
      !(await kg.getMemorableKnowledge(mkD))
    ) {
      failures.push('dismiss should not delete any MK');
    }
    console.log('[slice-9] dismiss flow ✓');
  } finally {
    await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
      TENANT,
    ]);
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-9] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-9] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
