/**
 * Trigger T1 (backfill) — one-shot promotion of existing durable `_rules/`
 * memory-files into the Knowledge-Graph as curated `manuallyAuthored` MK, so the
 * always-surface durable recall tier (B1) can surface them. Shares the exact
 * promotion logic with the live write-hook via `promoteRuleFileToDurable`.
 *
 * Usage (DRY-RUN by default — lists candidates, writes nothing):
 *   npx tsx scripts/backfill-durable-rules.ts
 *   npx tsx scripts/backfill-durable-rules.ts --apply
 *
 * Env: DATABASE_URL (required), GRAPH_TENANT_ID (default 'default'),
 *      OLLAMA_BASE_URL / ollama_base_url (default http://localhost:11434),
 *      OLLAMA_MODEL (default nomic-embed-text).
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';
import { createEmbeddingClient } from '@omadia/embeddings';
import {
  promoteRuleFileToDurable,
  isDurableRulePath,
  DURABLE_RULES_PREFIX,
} from '@omadia/orchestrator-extras';

const APPLY = process.argv.includes('--apply');
const TENANT = process.env['GRAPH_TENANT_ID'] ?? 'default';

function log(msg: string): void {
  console.log(msg);
}

async function main(): Promise<void> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL required');

  const ollamaBase =
    process.env['OLLAMA_BASE_URL'] ??
    process.env['ollama_base_url'] ??
    'http://localhost:11434';
  const ollamaModel = process.env['OLLAMA_MODEL'] ?? 'nomic-embed-text';

  log(
    `[durable-backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} tenant=${TENANT} ollama=${ollamaBase} model=${ollamaModel}`,
  );

  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  const embeddingClient = createEmbeddingClient({
    baseUrl: ollamaBase,
    model: ollamaModel,
  });
  const graph = new NeonKnowledgeGraph({
    pool,
    tenantId: TENANT,
    embeddingClient,
  });

  // Pre-flight the embedder — a durable MK without an embedding is invisible to
  // the recall tier, so fail loudly rather than create unsearchable nodes.
  try {
    const probe = await embeddingClient.embed('probe');
    log(`[durable-backfill] embedder OK (dims=${String(probe.length)})`);
  } catch (err) {
    throw new Error(
      `embedder unreachable at ${ollamaBase} (${err instanceof Error ? err.message : String(err)}). ` +
        `Run inside the middleware container or set OLLAMA_BASE_URL.`,
    );
  }

  const files = await pool.query<{ virtual_path: string; content: string }>(
    `SELECT virtual_path, content FROM memory_files
      WHERE virtual_path LIKE $1 || '%'
      ORDER BY virtual_path`,
    [DURABLE_RULES_PREFIX],
  );
  log(`[durable-backfill] found ${String(files.rows.length)} _rules/ file(s)`);

  let created = 0;
  let skipped = 0;
  for (const { virtual_path, content } of files.rows) {
    if (!isDurableRulePath(virtual_path)) {
      log(`  - SKIP ${virtual_path} (not a durable rule path)`);
      skipped++;
      continue;
    }
    if (!APPLY) {
      log(`  - WOULD PROMOTE ${virtual_path}`);
      created++;
      continue;
    }
    const res = await promoteRuleFileToDurable({
      pool,
      kg: graph,
      tenantId: TENANT,
      virtualPath: virtual_path,
      content,
      embeddingClient,
      log,
    });
    log(`  - ${res.action.toUpperCase()} ${virtual_path}${res.mkId ? ` (mk=${res.mkId})` : ''}`);
    if (res.action === 'created') created++;
    else skipped++;
  }

  log(
    `[durable-backfill] done: ${APPLY ? 'created' : 'would-create'}=${String(created)} skipped=${String(skipped)}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(
    '[durable-backfill] FAILED:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
