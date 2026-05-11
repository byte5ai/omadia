/**
 * Read-only inspector for the Neon graph state. Prints stats, session
 * summaries, and a few sample turns. No mutations.
 */
import 'dotenv/config';

import { createKnowledgeGraph } from '../src/services/graph/index.js';

async function main(): Promise<void> {
  const { graph, pool } = await createKnowledgeGraph({
    log: (msg) => console.log(msg),
  });
  if (!pool) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const stats = await graph.stats();
  console.log('\n=== stats ===');
  console.log(JSON.stringify(stats, null, 2));

  const sessions = await graph.listSessions();
  console.log(`\n=== sessions (${sessions.length}) ===`);
  for (const s of sessions) {
    console.log(
      `  ${s.scope.padEnd(40)} turns=${String(s.turnCount).padStart(3)}  ${s.firstAt} → ${s.lastAt}`,
    );
  }

  const tenant = process.env['GRAPH_TENANT_ID'] ?? 'default';
  const entityCount = await pool.query<{
    system: string;
    model: string;
    count: string;
  }>(
    `SELECT system, model, n::text AS count
       FROM (
         SELECT
           (properties->>'system') AS system,
           (properties->>'model')  AS model,
           COUNT(*)::int AS n
         FROM graph_nodes
         WHERE tenant_id = $1 AND type IN ('OdooEntity','ConfluencePage')
         GROUP BY 1,2
       ) t
     ORDER BY n DESC`,
    [tenant],
  );
  console.log(`\n=== entities by (system, model) ===`);
  for (const r of entityCount.rows) {
    console.log(`  ${r.system}:${r.model.padEnd(30)} ${r.count}`);
  }

  const migrations = await pool.query<{ id: string; applied_at: string }>(
    `SELECT id, applied_at::text FROM _graph_migrations ORDER BY id`,
  );
  console.log(`\n=== applied migrations ===`);
  for (const m of migrations.rows) {
    console.log(`  ${m.id}  @ ${m.applied_at}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
