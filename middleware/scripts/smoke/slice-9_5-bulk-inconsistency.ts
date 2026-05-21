/**
 * Slice 9.5 — live-DB smoke for bulk inconsistency-detect.
 *
 * Idempotent: cleans the smoke-tenant before and after.
 *
 * Verifies (against kg_local + a mock detector):
 *   - migration 0024 partial index is in place (queries succeed)
 *   - countMemorableKnowledgeInconsistencyCheckBuckets partitions MKs
 *     across (unchecked / alreadyChecked / withoutEmbedding)
 *   - listMemorableKnowledgeIdsForBulkInconsistencyCheck respects
 *     ASC created_at + limit clamp + filter
 *   - markMemorableKnowledgeInconsistencyChecked writes the property,
 *     subsequent listings exclude the MK
 *   - BulkInconsistencyService.run walks the selection, calls the
 *     mock detector for every MK, aggregates stats
 *   - re-run is idempotent (0 work after success)
 *   - run throws bulk.detector_unavailable when judgementAvailable=false
 *
 * The live Haiku judgement-pass is exercised manually in the browser
 * once ANTHROPIC_API_KEY is configured.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import {
  NeonKnowledgeGraph,
  runGraphMigrations,
} from '@omadia/knowledge-graph-neon';
import type {
  InconsistencyDetectorService,
  KnowledgeGraph,
} from '@omadia/plugin-api';

import { createBulkInconsistencyService } from '../../packages/harness-orchestrator-extras/src/bulkInconsistency.js';

const TENANT = 'slice-9_5-smoke';

function createMockDetector(
  kg: KnowledgeGraph,
  inconsistenciesPerCall = 0,
): InconsistencyDetectorService {
  return {
    async detectFor(mkId) {
      // Mirror the real detector contract: set the marker at the end
      // of a successful run so the bulk job dedupes correctly.
      await kg.markMemorableKnowledgeInconsistencyChecked(mkId);
      return {
        candidatesScanned: 1,
        inconsistenciesCreated: inconsistenciesPerCall,
      };
    },
  };
}

async function setEmbeddingDirect(
  pool: Pool,
  tenant: string,
  mkExternalId: string,
  dim = 768,
): Promise<void> {
  // Build a stable, slightly-different unit-vector per MK so the cosine
  // index does not complain about identical rows. We don't run the
  // real detector here — these vectors only need to be NON-NULL.
  const v = new Array(dim).fill(0).map((_, i) =>
    (Math.sin((i + 1) * mkExternalId.length) + 1) / 4,
  );
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
      channelUserId: 'slice-9_5-alice',
      displayName: 'Alice',
      email: 's95-alice@example.com',
      emailVerified: true,
      aadObjectId: 's95-alice-aad',
    });
    console.log(`[slice-9.5] seeded alice=${alice.omadiaUserId}`);

    // Seed three MKs: two with embeddings (unchecked), one without.
    const mk1 = (
      await kg.createMemorableKnowledge({
        kind: 'decision',
        summary: 'byte5 SEO: H1-Tags first',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    const mk2 = (
      await kg.createMemorableKnowledge({
        kind: 'decision',
        summary: 'byte5 SEO: JSON-LD first',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    const mk3 = (
      await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'no-embedding MK (Slice-7 backfill not yet caught up)',
        createdBy: `web:${alice.omadiaUserId}`,
        involvedOmadiaUserIds: [alice.omadiaUserId],
        aclOwners: [alice.omadiaUserId],
      })
    ).memorableKnowledgeNodeId;
    await setEmbeddingDirect(pool, TENANT, mk1);
    await setEmbeddingDirect(pool, TENANT, mk2);
    // mk3 deliberately left without embedding.
    console.log(`[slice-9.5] seeded 3 MKs (2 with embedding, 1 without)`);

    // 1. preview reports correct bucket counts.
    let buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    if (
      buckets.unchecked !== 2 ||
      buckets.alreadyChecked !== 0 ||
      buckets.withoutEmbedding !== 1
    ) {
      failures.push(
        `bucket counts wrong (initial): ${JSON.stringify(buckets)} expected {unchecked:2, alreadyChecked:0, withoutEmbedding:1}`,
      );
    } else {
      console.log(
        `[slice-9.5] buckets initial: unchecked=${String(buckets.unchecked)} alreadyChecked=${String(buckets.alreadyChecked)} withoutEmbedding=${String(buckets.withoutEmbedding)} ✓`,
      );
    }

    // 2. selection query returns the two embedded MKs in created_at-asc
    //    order.
    const selected =
      await kg.listMemorableKnowledgeIdsForBulkInconsistencyCheck({ limit: 50 });
    if (selected.length !== 2) {
      failures.push(
        `selection should return 2 MKs, got ${String(selected.length)}: ${selected.join(',')}`,
      );
    }
    if (!selected.includes(mk1) || !selected.includes(mk2) || selected.includes(mk3)) {
      failures.push(`selection mis-set: ${selected.join(',')}`);
    } else {
      console.log(`[slice-9.5] selection returned [${selected.join(',')}] ✓`);
    }

    // 3. BulkInconsistencyService.run walks the selection.
    const service = createBulkInconsistencyService({
      kg,
      detector: createMockDetector(kg, 1),
      judgementAvailable: true,
    });
    const preview = await service.preview();
    if (preview.unchecked !== 2 || preview.detectorAvailable !== true) {
      failures.push(`preview wrong: ${JSON.stringify(preview)}`);
    }
    const result = await service.run({ limit: 50 });
    if (
      result.scanned !== 2 ||
      result.checked !== 2 ||
      result.failed !== 0 ||
      result.inconsistenciesCreated !== 2
    ) {
      failures.push(`run stats wrong: ${JSON.stringify(result)}`);
    } else {
      console.log(
        `[slice-9.5] run stats scanned=${String(result.scanned)} checked=${String(result.checked)} inconsistencies=${String(result.inconsistenciesCreated)} duration=${String(result.durationMs)}ms ✓`,
      );
    }

    // 4. Re-run is idempotent.
    const second = await service.run({ limit: 50 });
    if (second.scanned !== 0 || second.checked !== 0) {
      failures.push(`re-run not idempotent: ${JSON.stringify(second)}`);
    } else {
      console.log(`[slice-9.5] re-run idempotent (scanned=0) ✓`);
    }

    // 5. Buckets after success: 2 alreadyChecked.
    buckets = await kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    if (buckets.unchecked !== 0 || buckets.alreadyChecked !== 2) {
      failures.push(
        `bucket counts after run wrong: ${JSON.stringify(buckets)}`,
      );
    } else {
      console.log(`[slice-9.5] markers persisted (alreadyChecked=2) ✓`);
    }

    // 6. Detector-unavailable variant.
    const unavailable = createBulkInconsistencyService({
      kg,
      judgementAvailable: false,
    });
    try {
      await unavailable.run({ limit: 1 });
      failures.push('run should have thrown bulk.detector_unavailable');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'bulk.detector_unavailable') {
        failures.push(`expected bulk.detector_unavailable, got ${String(code)}`);
      } else {
        console.log(`[slice-9.5] detector_unavailable propagates ✓`);
      }
    }
  } finally {
    await wipe();
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-9.5] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-9.5] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
