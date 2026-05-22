/**
 * Slice 4b — live-DB smoke for promoteTurnIfSignificant.
 *
 * Idempotent: cleans the smoke-tenant before and after itself.
 *
 * Verifies:
 *   - significance >= threshold → MK created with derivedFromTurnIds
 *     + aclOwners + INVOLVED set up.
 *   - re-run on the same turn → reason='already-promoted', no second MK.
 *   - significance < threshold → reason='below-threshold', no MK.
 *   - significance NULL (capture_level=minimal) → reason='no-significance'.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import { promoteTurnIfSignificant } from '@omadia/orchestrator-extras';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

const TENANT = 'slice-4b-smoke';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url || !(url.includes('localhost') || url.includes('127.0.0.1'))) {
    console.error('refusing — DATABASE_URL must point at localhost');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 2 });
  const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
  const failures: string[] = [];

  // Reset smoke-tenant.
  await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [
    TENANT,
  ]);

  try {
    // Seed a User-Cluster so the resulting MK has a valid INVOLVED endpoint.
    const cluster = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'slice-4b-row',
      displayName: 'Slice 4b Smoke',
      email: 'slice4b@example.com',
      emailVerified: true,
      aadObjectId: 'slice-4b-aad',
    });
    console.log(`[slice-4b] seeded user cluster=${cluster.omadiaUserId}`);

    // Direct INSERT a Turn with synthetic significance — bypasses the
    // capture-filter so the smoke runs regardless of CAPTURE_LEVEL.
    const turnIdHigh = `turn:smoke-4b-high:${new Date().toISOString()}`;
    const turnIdLow = `turn:smoke-4b-low:${new Date(Date.now() + 1).toISOString()}`;
    const turnIdNull = `turn:smoke-4b-null:${new Date(Date.now() + 2).toISOString()}`;
    for (const [extId, sig] of [
      [turnIdHigh, 0.9],
      [turnIdLow, 0.3],
      [turnIdNull, null],
    ] as const) {
      await pool.query(
        `INSERT INTO graph_nodes (external_id, type, tenant_id, scope, properties, entry_type, visibility, significance)
         VALUES ($1, 'Turn', $2, 'smoke-scope', '{"summary":"smoke turn body"}'::jsonb, 'memory', 'team', $3)`,
        [extId, TENANT, sig],
      );
    }

    // 1. High significance → PROMOTED
    const highRes = await promoteTurnIfSignificant({
      pool,
      tenantId: TENANT,
      kg,
      turnId: turnIdHigh,
      userId: cluster.omadiaUserId,
      threshold: 0.7,
      fallbackAssistantAnswer: 'pgvector mit Dim 768 nach Migration 0007.',
      log: () => {},
    });
    if (!highRes.promoted) {
      failures.push(
        `high-significance: expected promoted=true, got reason=${highRes.reason}`,
      );
    } else if (!highRes.mkId?.startsWith('mk:')) {
      failures.push(`high-significance: bad mkId=${String(highRes.mkId)}`);
    } else {
      console.log(`[slice-4b] PROMOTED ${turnIdHigh.slice(0, 24)}… → ${highRes.mkId} ✓`);
    }

    // 2. Idempotency: re-run on same high-significance turn → already-promoted
    const idemRes = await promoteTurnIfSignificant({
      pool,
      tenantId: TENANT,
      kg,
      turnId: turnIdHigh,
      userId: cluster.omadiaUserId,
      threshold: 0.7,
      fallbackAssistantAnswer: 'pgvector mit Dim 768 nach Migration 0007.',
      log: () => {},
    });
    if (idemRes.reason !== 'already-promoted') {
      failures.push(
        `idempotency: expected reason=already-promoted, got ${idemRes.reason}`,
      );
    } else {
      console.log(`[slice-4b] idempotency ✓ (reason=already-promoted)`);
    }

    // 3. Low significance → below-threshold
    const lowRes = await promoteTurnIfSignificant({
      pool,
      tenantId: TENANT,
      kg,
      turnId: turnIdLow,
      userId: cluster.omadiaUserId,
      threshold: 0.7,
      fallbackAssistantAnswer: '…',
      log: () => {},
    });
    if (lowRes.reason !== 'below-threshold') {
      failures.push(
        `low-significance: expected reason=below-threshold, got ${lowRes.reason}`,
      );
    } else {
      console.log(`[slice-4b] below-threshold ✓ (sig=0.30)`);
    }

    // 4. Null significance → no-significance
    const nullRes = await promoteTurnIfSignificant({
      pool,
      tenantId: TENANT,
      kg,
      turnId: turnIdNull,
      userId: cluster.omadiaUserId,
      threshold: 0.7,
      fallbackAssistantAnswer: '…',
      log: () => {},
    });
    if (nullRes.reason !== 'no-significance') {
      failures.push(
        `null-significance: expected reason=no-significance, got ${nullRes.reason}`,
      );
    } else {
      console.log(`[slice-4b] no-significance ✓ (scorer-off path)`);
    }

    // 5. Verify the created MK has the expected shape.
    if (highRes.mkId) {
      const node = await kg.getMemorableKnowledge(
        highRes.mkId,
        cluster.omadiaUserId,
      );
      if (!node) {
        failures.push(`getMemorableKnowledge returned null for ${highRes.mkId}`);
      } else {
        const props = node.props as {
          kind?: string;
          acl_owners?: string[];
          created_by?: string;
        };
        if (props.kind !== 'insight') {
          failures.push(`expected kind=insight (fallback), got ${String(props.kind)}`);
        }
        if (!(props.acl_owners ?? []).includes(cluster.omadiaUserId)) {
          failures.push(`acl_owners missing creator`);
        }
        if (!props.created_by?.startsWith('auto:')) {
          failures.push(`created_by should start with 'auto:', got ${String(props.created_by)}`);
        }
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
    console.error('\n[slice-4b] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-4b] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
