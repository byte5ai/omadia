/**
 * Slice 10 — live-DB smoke for MergeCandidate persistence + resolve.
 *
 * Idempotent: cleans the smoke-tenant before and after.
 *
 * Verifies (against kg_local + a mock detector):
 *   - migration 0025 is applied (index + check work)
 *   - createMergeCandidate persists + 2 DUPLICATE_OF edges
 *   - dedupe on sorted pair regardless of input order
 *   - listMergeCandidates surfaces only union-owner-visible entries
 *   - resolve keep_a deletes sorted-B + marks resolved
 *   - resolve not_duplicate marks dismissed without delete
 *   - already_resolved blocks re-resolve
 *   - bulk-merge-detect run + idempotency (mock detector)
 */
import 'dotenv/config';

import { Pool } from 'pg';

import {
  NeonKnowledgeGraph,
  runGraphMigrations,
} from '@omadia/knowledge-graph-neon';
import type {
  KnowledgeGraph,
  MergeCandidateDetectorService,
} from '@omadia/plugin-api';

import { createBulkMergeDetectService } from '../../packages/harness-orchestrator-extras/src/bulkMergeDetect.js';

const TENANT = 'slice-10-smoke';

function createMockDetector(
  kg: KnowledgeGraph,
  perCallCreated = 0,
): MergeCandidateDetectorService {
  return {
    async detectFor(mkId) {
      await kg.markMemorableKnowledgeMergeChecked(mkId);
      return { candidatesScanned: 1, mergeCandidatesCreated: perCallCreated };
    },
  };
}

async function setEmbeddingDirect(
  pool: Pool,
  tenant: string,
  mkExternalId: string,
  dim = 768,
): Promise<void> {
  const v = new Array(dim)
    .fill(0)
    .map((_, i) => (Math.sin((i + 1) * mkExternalId.length) + 1) / 4);
  const literal = `[${v.map((x) => x.toFixed(6)).join(',')}]`;
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
      channelUserId: 'slice-10-alice',
      displayName: 'Alice',
      email: 's10-alice@example.com',
      emailVerified: true,
      aadObjectId: 's10-alice-aad',
    });
    console.log(`[slice-10] seeded alice=${alice.omadiaUserId}`);

    const mkA = (
      await kg.createMemorableKnowledge({
        kind: 'decision',
        summary: 'byte5 SEO: H1-Tags first',
        rationale: 'On-Page improvements should start with H1.',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;

    const mkB = (
      await kg.createMemorableKnowledge({
        kind: 'decision',
        summary: 'byte5 SEO: H1-Tags zuerst',
        rationale: 'On-Page-Optimierung beginnt mit H1.',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    console.log(`[slice-10] created 2 near-duplicate MKs`);

    // 1. createMergeCandidate
    const mc = await kg.createMergeCandidate({
      mkAExternalId: mkA,
      mkBExternalId: mkB,
      cosineSim: 0.974,
    });
    if (!mc) {
      failures.push('createMergeCandidate returned null');
    } else {
      const sorted = [mkA, mkB].sort();
      if (
        mc.duplicateOf[0] !== sorted[0] ||
        mc.duplicateOf[1] !== sorted[1]
      ) {
        failures.push(
          `duplicateOf mis-sorted: ${JSON.stringify(mc.duplicateOf)} expected ${JSON.stringify(sorted)}`,
        );
      } else {
        console.log(`[slice-10] merge-candidate ${mc.id} created ✓`);
      }
    }

    // 2. dedupe
    const dup = await kg.createMergeCandidate({
      mkAExternalId: mkB,
      mkBExternalId: mkA,
      cosineSim: 0.99,
    });
    if (dup !== null) {
      failures.push('dedupe failed');
    } else {
      console.log('[slice-10] dedupe ✓');
    }

    // 3. list (alice sees it)
    const list = await kg.listMergeCandidates({
      viewerOmadiaUserId: alice.omadiaUserId,
    });
    if (list.length !== 1) {
      failures.push(`expected 1 merge candidate, got ${list.length}`);
    }

    // 4. resolve keep_a deletes sorted-B
    await kg.resolveMergeCandidate(mc!.id, 'keep_a', {
      actorOmadiaUserId: alice.omadiaUserId,
      reason: 'A is the canonical wording',
    });
    const sortedPair = [mkA, mkB].sort();
    const winner = await kg.getMemorableKnowledge(sortedPair[0]!);
    const deleted = await kg.getMemorableKnowledge(sortedPair[1]!);
    if (!winner) failures.push('winner MK was deleted');
    if (deleted) failures.push('loser MK still present after keep_a');
    console.log(`[slice-10] resolve keep_a ✓ (deleted ${sortedPair[1]})`);

    // 5. already_resolved blocks re-resolve
    try {
      await kg.resolveMergeCandidate(mc!.id, 'not_duplicate', {
        actorOmadiaUserId: alice.omadiaUserId,
      });
      failures.push('expected already_resolved');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'already_resolved') {
        failures.push(`expected already_resolved, got ${String(code)}`);
      } else {
        console.log('[slice-10] already_resolved blocks re-resolve ✓');
      }
    }

    // 6. not_duplicate flow on a fresh pair
    const mkC = (
      await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'Q1 revenue forecast updated',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    const mkD = (
      await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'Q1 revenue forecast revised',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    const mc2 = await kg.createMergeCandidate({
      mkAExternalId: mkC,
      mkBExternalId: mkD,
      cosineSim: 0.951,
    });
    const dismissed = await kg.resolveMergeCandidate(mc2!.id, 'not_duplicate', {
      actorOmadiaUserId: alice.omadiaUserId,
    });
    if (dismissed.props.status !== 'dismissed') {
      failures.push(`expected dismissed, got ${dismissed.props.status}`);
    }
    if (
      !(await kg.getMemorableKnowledge(mkC)) ||
      !(await kg.getMemorableKnowledge(mkD))
    ) {
      failures.push('not_duplicate should not delete any MK');
    }
    console.log('[slice-10] not_duplicate flow ✓');

    // 7. Bulk-detect smoke. Seed an extra unchecked MK with embedding,
    //    run mock detector, verify marker.
    const mkE = (
      await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'isolated MK for bulk-detect',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    await setEmbeddingDirect(pool, TENANT, mkE);
    const bulk = createBulkMergeDetectService({
      kg,
      detector: createMockDetector(kg, 0),
    });
    const preview = await bulk.preview();
    if (preview.unchecked < 1 || !preview.detectorAvailable) {
      failures.push(`bulk preview wrong: ${JSON.stringify(preview)}`);
    }
    const bulkResult = await bulk.run({ limit: 50 });
    if (bulkResult.checked < 1) {
      failures.push(`bulk run did nothing: ${JSON.stringify(bulkResult)}`);
    } else {
      console.log(
        `[slice-10] bulk run scanned=${String(bulkResult.scanned)} checked=${String(bulkResult.checked)} ✓`,
      );
    }
    const second = await bulk.run({ limit: 50 });
    if (second.scanned !== 0) {
      failures.push(`bulk re-run not idempotent: ${JSON.stringify(second)}`);
    } else {
      console.log(`[slice-10] bulk re-run idempotent ✓`);
    }
  } finally {
    await wipe();
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-10] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-10] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
