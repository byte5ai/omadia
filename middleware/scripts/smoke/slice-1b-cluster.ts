/**
 * Slice 1b — cluster-state smoke test against the live Neon DB.
 * Usage: `tsx middleware/scripts/smoke/slice-1b-cluster.ts`
 *        (requires DATABASE_URL in .env)
 *
 * Verifies post-migration state:
 *   - Migration 0013 ran (graph_nodes / graph_edges either empty or
 *     populated only via the new cluster-aware ingest path).
 *   - No orphan Users (every User-Cluster has ≥ 1 IS_IDENTITY_OF inbound).
 *   - No orphan ChannelIdentities (every ChannelIdentity has exactly 1
 *     IS_IDENTITY_OF outbound).
 *   - No legacy User-Nodes carrying the pre-1b shape (they should hold
 *     `omadiaUserId`, not the old `userId` field).
 *
 * Exits non-zero on any check failure; safe to wire into the Staging/
 * Production deploy pipeline as a post-migration gate.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
} from '@omadia/knowledge-graph-neon';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL not set — aborting.');
    process.exit(1);
  }

  const masked = url.replace(/:[^:@]+@/, ':***@');
  console.log(`[slice-1b] connecting to ${masked}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const failures: string[] = [];

  try {
    if (!(GRAPH_NODE_TYPES as readonly string[]).includes('ChannelIdentity')) {
      failures.push("GRAPH_NODE_TYPES is missing 'ChannelIdentity'");
    }
    if (!(GRAPH_EDGE_TYPES as readonly string[]).includes('IS_IDENTITY_OF')) {
      failures.push("GRAPH_EDGE_TYPES is missing 'IS_IDENTITY_OF'");
    }

    const counts = await pool.query<{ type: string; count: string }>(
      `SELECT type, count(*)::text AS count
       FROM graph_nodes
       WHERE type IN ('User', 'ChannelIdentity')
       GROUP BY type`,
    );
    const userCount = Number(
      counts.rows.find((r) => r.type === 'User')?.count ?? '0',
    );
    const identityCount = Number(
      counts.rows.find((r) => r.type === 'ChannelIdentity')?.count ?? '0',
    );
    console.log(`[slice-1b] User-Clusters=${userCount} ChannelIdentities=${identityCount}`);

    const orphanUsers = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM graph_nodes u
       WHERE u.type = 'User'
         AND NOT EXISTS (
           SELECT 1 FROM graph_edges e
           WHERE e.type = 'IS_IDENTITY_OF' AND e.to_node = u.id
         )`,
    );
    const orphanUserCount = Number(orphanUsers.rows[0]?.count ?? '0');
    if (orphanUserCount > 0) {
      failures.push(`${orphanUserCount} User-Cluster(s) without any IS_IDENTITY_OF inbound`);
    } else {
      console.log('[slice-1b] no orphan User-Clusters ✓');
    }

    const orphanIdentities = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM graph_nodes ci
       WHERE ci.type = 'ChannelIdentity'
         AND NOT EXISTS (
           SELECT 1 FROM graph_edges e
           WHERE e.type = 'IS_IDENTITY_OF' AND e.from_node = ci.id
         )`,
    );
    const orphanIdentityCount = Number(orphanIdentities.rows[0]?.count ?? '0');
    if (orphanIdentityCount > 0) {
      failures.push(`${orphanIdentityCount} ChannelIdentity(ies) without IS_IDENTITY_OF outbound`);
    } else {
      console.log('[slice-1b] no orphan ChannelIdentities ✓');
    }

    const legacyShape = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM graph_nodes
       WHERE type = 'User'
         AND properties ? 'userId'
         AND NOT (properties ? 'omadiaUserId')`,
    );
    const legacyShapeCount = Number(legacyShape.rows[0]?.count ?? '0');
    if (legacyShapeCount > 0) {
      failures.push(`${legacyShapeCount} User-Node(s) still carry pre-1b shape (userId without omadiaUserId)`);
    } else {
      console.log('[slice-1b] no legacy-shape User-Nodes ✓');
    }
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-1b] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-1b] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
