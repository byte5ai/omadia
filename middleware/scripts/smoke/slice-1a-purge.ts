/**
 * Slice 1a — purge verification smoke test against the live Neon DB.
 * Usage: `tsx middleware/scripts/smoke/slice-1a-purge.ts`
 *        (requires DATABASE_URL in .env)
 *
 * Asserts that after migration 0012 ran:
 *   - Zero nodes of type Company / Person / FinancialSnapshot remain.
 *   - Zero edges of type MANAGES / SHAREHOLDER_OF / SUCCEEDED_BY /
 *     HAS_FINANCIALS / REFERS_TO remain.
 *   - The Zod schema rejects `{type: 'Company'}` as an unknown node type.
 *
 * Exits non-zero on any check failure so it can be wired into the
 * Staging/Production deploy pipeline as a post-migration gate.
 */
import 'dotenv/config';

import { Pool } from 'pg';

import { GraphNodeTypeSchema, validateNodeProps } from '@omadia/knowledge-graph-neon';

const REMOVED_NODE_TYPES = ['Company', 'Person', 'FinancialSnapshot'] as const;
const REMOVED_EDGE_TYPES = [
  'MANAGES',
  'SHAREHOLDER_OF',
  'SUCCEEDED_BY',
  'HAS_FINANCIALS',
  'REFERS_TO',
] as const;

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL not set — aborting.');
    process.exit(1);
  }

  const masked = url.replace(/:[^:@]+@/, ':***@');
  console.log(`[slice-1a] connecting to ${masked}`);

  const pool = new Pool({ connectionString: url, max: 2 });
  const failures: string[] = [];

  try {
    for (const type of REMOVED_NODE_TYPES) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM graph_nodes WHERE type = $1`,
        [type],
      );
      const count = Number(rows[0]?.count ?? '0');
      if (count > 0) {
        failures.push(`graph_nodes.type='${type}' has ${count} residual rows`);
      } else {
        console.log(`[slice-1a] graph_nodes.type='${type}' → 0 ✓`);
      }
    }

    for (const type of REMOVED_EDGE_TYPES) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM graph_edges WHERE type = $1`,
        [type],
      );
      const count = Number(rows[0]?.count ?? '0');
      if (count > 0) {
        failures.push(`graph_edges.type='${type}' has ${count} residual rows`);
      } else {
        console.log(`[slice-1a] graph_edges.type='${type}' → 0 ✓`);
      }
    }

    for (const type of REMOVED_NODE_TYPES) {
      const parsed = GraphNodeTypeSchema.safeParse(type);
      if (parsed.success) {
        failures.push(`GraphNodeTypeSchema still accepts '${type}'`);
      } else {
        console.log(`[slice-1a] GraphNodeTypeSchema rejects '${type}' ✓`);
      }
    }

    for (const type of REMOVED_NODE_TYPES) {
      try {
        validateNodeProps(type as never, {} as Record<string, unknown>);
        failures.push(`validateNodeProps did not throw for '${type}'`);
      } catch {
        console.log(`[slice-1a] validateNodeProps throws on '${type}' ✓`);
      }
    }
  } finally {
    await pool.end();
  }

  if (failures.length > 0) {
    console.error('\n[slice-1a] FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[slice-1a] all checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
