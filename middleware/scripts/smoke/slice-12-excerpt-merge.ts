/**
 * Slice 12 — live-DB smoke for ExcerptMergeCandidate persistence +
 * resolve. Mirror of slice-10-merge-candidate smoke but at the
 * Excerpt layer.
 *
 * Idempotent: cleans the smoke-tenant before and after.
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

import { createBulkExcerptMergeDetectService } from '../../packages/harness-orchestrator-extras/src/bulkExcerptMergeDetect.js';

const TENANT = 'slice-12-smoke';

function createMockDetector(
  kg: KnowledgeGraph,
  perCallCreated = 0,
): MergeCandidateDetectorService {
  return {
    async detectFor() {
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    },
    async detectForExcerpt(excerptId) {
      await kg.markPalaiaExcerptMergeChecked(excerptId);
      return {
        candidatesScanned: 1,
        excerptMergeCandidatesCreated: perCallCreated,
      };
    },
  };
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
      channelUserId: 'slice-12-alice',
      displayName: 'Alice',
      email: 's12-alice@example.com',
      emailVerified: true,
      aadObjectId: 's12-alice-aad',
    });
    console.log(`[slice-12] seeded alice=${alice.omadiaUserId}`);

    // Create one MK with two near-duplicate excerpts.
    const mkResult = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'byte5 SEO: keine strukturierten Daten',
      rationale: 'Audit-Befund',
      createdBy: `web:${alice.omadiaUserId}`,
      involvedOmadiaUserIds: [alice.omadiaUserId],
      aclOwners: [alice.omadiaUserId],
      palaiaExcerpts: {
        source: 'llm',
        texts: [
          'Keine Structured Data auf byte5.de eingesetzt.',
          'Kein JSON-LD strukturiertes Markup auf byte5.de gefunden.',
        ],
      },
    });
    console.log(`[slice-12] MK created: ${mkResult.memorableKnowledgeNodeId}`);

    const excerpts = await kg.listExcerptsForMemory(mkResult.memorableKnowledgeNodeId);
    if (excerpts.length !== 2) {
      failures.push(`expected 2 excerpts, got ${excerpts.length}`);
    }
    const [excA, excB] = excerpts;
    if (!excA || !excB) throw new Error('missing excerpts');

    // 1. createExcerptMergeCandidate
    const mc = await kg.createExcerptMergeCandidate({
      excerptAExternalId: excA.id,
      excerptBExternalId: excB.id,
      cosineSim: 0.98,
    });
    if (!mc) {
      failures.push('createExcerptMergeCandidate returned null');
    } else {
      console.log(`[slice-12] ExcerptMergeCandidate ${mc.id} created ✓`);
    }

    // 2. dedupe
    const dup = await kg.createExcerptMergeCandidate({
      excerptAExternalId: excB.id,
      excerptBExternalId: excA.id,
      cosineSim: 0.99,
    });
    if (dup !== null) failures.push('dedupe failed');
    else console.log('[slice-12] dedupe ✓');

    // 3. list (alice sees it)
    const list = await kg.listExcerptMergeCandidates({
      viewerOmadiaUserId: alice.omadiaUserId,
    });
    if (list.length !== 1) {
      failures.push(`expected 1 ExcerptMergeCandidate, got ${list.length}`);
    }

    // 4. resolve keep_a deletes loser excerpt
    const sortedPair = [excA.id, excB.id].sort();
    await kg.resolveExcerptMergeCandidate(mc!.id, 'keep_a', {
      actorOmadiaUserId: alice.omadiaUserId,
      reason: 'A is canonical',
    });
    const afterExcerpts = await kg.listExcerptsForMemory(
      mkResult.memorableKnowledgeNodeId,
    );
    const deletedExternal = sortedPair[1];
    if (afterExcerpts.some((e) => e.id === deletedExternal)) {
      failures.push(`loser excerpt ${deletedExternal} still present`);
    } else {
      console.log(`[slice-12] keep_a deleted ${deletedExternal} ✓`);
    }

    // 5. already_resolved blocks re-resolve
    try {
      await kg.resolveExcerptMergeCandidate(mc!.id, 'not_duplicate', {
        actorOmadiaUserId: alice.omadiaUserId,
      });
      failures.push('expected already_resolved');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'already_resolved') {
        failures.push(`expected already_resolved, got ${String(code)}`);
      } else {
        console.log('[slice-12] already_resolved blocks re-resolve ✓');
      }
    }

    // 6. delete_excerpt audit-row exists
    const audit = await kg.listMemoryAclAudit(
      mkResult.memorableKnowledgeNodeId,
    );
    const deleteRow = audit.find((a) => a.action === 'delete_excerpt');
    if (!deleteRow) {
      failures.push('delete_excerpt audit row missing');
    } else {
      console.log('[slice-12] delete_excerpt audit-row written ✓');
    }

    // 7. Bulk-service shape: preview + run (mock detector)
    const bulk = createBulkExcerptMergeDetectService({
      kg,
      detector: createMockDetector(kg, 0),
    });
    const preview = await bulk.preview();
    if (!preview.detectorAvailable) {
      failures.push('detectorAvailable should be true for cosine-only');
    }
    const result = await bulk.run({ limit: 50 });
    console.log(
      `[slice-12] bulk run scanned=${String(result.scanned)} checked=${String(result.checked)} ✓`,
    );
  } finally {
    await wipe();
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-12] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-12] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
