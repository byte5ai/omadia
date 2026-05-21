/**
 * Slice 8 — live-DB smoke for the retrospective bulk score + promote
 * pipeline.
 *
 * Idempotent: cleans the smoke-tenant before and after.
 *
 * Verifies (against kg_local with a deterministic mock-scorer so this
 * runs without an Anthropic key + spends $0):
 *   - preview() reports correct counts before/after.
 *   - run() phase 1 scores all NULL-significance Turns.
 *   - run() phase 2 promotes >= threshold Turns into MKs.
 *   - re-run is a no-op (idempotent on both phases).
 *   - run() without scorer throws bulk.scorer_unavailable.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import {
  NeonKnowledgeGraph,
  runGraphMigrations,
} from '@omadia/knowledge-graph-neon';
import {
  createBulkPromotionService,
  type SignificanceScorer,
} from '@omadia/orchestrator-extras';

const TENANT = 'slice-8-smoke';

/** Deterministic scorer: returns the score baked into the user-message
 *  prefix `score:0.NN|` so tests can dial significance per-row without
 *  spending any Anthropic budget. */
function createMockScorer(): SignificanceScorer {
  return {
    async score(text: string): Promise<{ score: number }> {
      const match = text.match(/^score:(\d+(?:\.\d+)?)\|/);
      const score = match ? Number(match[1]) : 0.5;
      return { score };
    },
  };
}

async function seedTurn(
  pool: Pool,
  externalId: string,
  userId: string,
  userMessage: string,
  significance: number | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO graph_nodes
       (external_id, type, tenant_id, properties, user_id, significance)
     VALUES ($1, 'Turn', $2, $3::jsonb, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      externalId,
      TENANT,
      JSON.stringify({
        scope: 'smoke-scope',
        time: new Date().toISOString(),
        userMessage,
        assistantAnswer: 'mock answer',
      }),
      userId,
      significance,
    ],
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

  await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
    TENANT,
  ]);

  try {
    const cluster = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-8-row',
      displayName: 'Slice 8 Smoke',
      email: 's8@example.com',
      emailVerified: true,
      aadObjectId: 's8-aad',
    });
    console.log(`[slice-8] seeded user cluster=${cluster.omadiaUserId}`);

    // Seed 5 Turns: 3 NULL-significance (one with score:0.9 prefix → high
    // after scoring; one with score:0.4 → below threshold; one empty),
    // 2 with pre-set significance=0.85 (already-scored, just need promotion).
    await seedTurn(
      pool,
      'turn:smoke:t1',
      cluster.omadiaUserId,
      'score:0.9|This decision matters.',
      null,
    );
    await seedTurn(
      pool,
      'turn:smoke:t2',
      cluster.omadiaUserId,
      'score:0.4|Just chitchat.',
      null,
    );
    await seedTurn(
      pool,
      'turn:smoke:t3',
      cluster.omadiaUserId,
      'score:0.95|Critical insight.',
      null,
    );
    await seedTurn(
      pool,
      'turn:smoke:t4',
      cluster.omadiaUserId,
      'pre-scored important content',
      0.85,
    );
    await seedTurn(
      pool,
      'turn:smoke:t5',
      cluster.omadiaUserId,
      'pre-scored other content',
      0.85,
    );

    const service = createBulkPromotionService({
      pool,
      tenantId: TENANT,
      kg,
      scorer: createMockScorer(),
      defaultThreshold: 0.7,
    });

    // ── 1. preview ───────────────────────────────────────────────
    const preview1 = await service.preview(0.7);
    console.log(
      `[slice-8] preview before: null=${preview1.nullSignificanceCount} eligible=${preview1.eligibleForPromoteCount} already=${preview1.alreadyPromotedCount}`,
    );
    if (preview1.nullSignificanceCount !== 3) {
      failures.push(`preview null expected 3 got ${preview1.nullSignificanceCount}`);
    }
    if (preview1.eligibleForPromoteCount !== 2) {
      failures.push(
        `preview eligible expected 2 got ${preview1.eligibleForPromoteCount}`,
      );
    }
    if (!preview1.scorerAvailable) {
      failures.push('preview scorerAvailable should be true with mock');
    }

    // ── 2. run ───────────────────────────────────────────────────
    const result = await service.run({ threshold: 0.7 });
    console.log(
      `[slice-8] run: scored=${result.scorePhase.scored} promoted=${result.promotePhase.promoted} already=${result.promotePhase.alreadyPromoted}`,
    );
    if (result.scorePhase.scored !== 3) {
      failures.push(`expected 3 scored, got ${result.scorePhase.scored}`);
    }
    // 4 should promote: t1 (score:0.9), t3 (0.95), t4 (0.85), t5 (0.85).
    // t2 (0.4) below threshold.
    if (result.promotePhase.promoted !== 4) {
      failures.push(`expected 4 promoted, got ${result.promotePhase.promoted}`);
    }
    if (result.promotePhase.belowThreshold !== 0) {
      // Below-threshold turns aren't picked up by the SELECT (filtered at
      // SQL-level via significance >= threshold), so the count is the
      // number of rows that the SELECT returned and turned out below.
      // Mock scorer keeps t2 below threshold so the SELECT excludes it
      // BEFORE this counter — expected 0.
      failures.push(
        `expected 0 below-threshold (filtered at SELECT), got ${result.promotePhase.belowThreshold}`,
      );
    }

    // ── 3. re-run is a no-op ─────────────────────────────────────
    const result2 = await service.run({ threshold: 0.7 });
    if (result2.scorePhase.scored !== 0) {
      failures.push(`re-run score expected 0, got ${result2.scorePhase.scored}`);
    }
    if (result2.promotePhase.promoted !== 0) {
      failures.push(
        `re-run promoted expected 0, got ${result2.promotePhase.promoted}`,
      );
    }
    console.log(
      `[slice-8] re-run no-op: scored=${result2.scorePhase.scored} promoted=${result2.promotePhase.promoted}`,
    );

    // ── 4. preview after ─────────────────────────────────────────
    const preview2 = await service.preview(0.7);
    if (preview2.nullSignificanceCount !== 0) {
      failures.push(
        `preview-after null expected 0, got ${preview2.nullSignificanceCount}`,
      );
    }
    if (preview2.alreadyPromotedCount !== 4) {
      failures.push(
        `preview-after already expected 4, got ${preview2.alreadyPromotedCount}`,
      );
    }

    // ── 5. service without scorer 503s ───────────────────────────
    const noScorerService = createBulkPromotionService({
      pool,
      tenantId: TENANT,
      kg,
      defaultThreshold: 0.7,
    });
    try {
      await noScorerService.run({});
      failures.push('expected scorer_unavailable from no-scorer service');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'bulk.scorer_unavailable') {
        failures.push(`expected bulk.scorer_unavailable, got ${String(code)}`);
      } else {
        console.log('[slice-8] no-scorer service throws scorer_unavailable ✓');
      }
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
    console.error('\n[slice-8] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-8] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
