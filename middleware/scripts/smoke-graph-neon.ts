/**
 * Connectivity smoke test for the Neon-backed knowledge graph.
 * Usage: `npm run smoke:graph` (requires DATABASE_URL in .env)
 *
 * Runs end-to-end: connect → migrate → ingest → query → stats → cleanup.
 * Leaves a `smoke:<timestamp>` scope behind so repeated runs stay idempotent.
 */
import 'dotenv/config';

import { createKnowledgeGraph } from '../src/services/graph/index.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL not set — aborting.');
    process.exit(1);
  }

  const masked = url.replace(/:[^:@]+@/, ':***@');
  console.log(`[smoke] connecting to ${masked}`);

  const started = Date.now();
  const { graph, pool } = await createKnowledgeGraph({
    log: (msg) => console.log(msg),
  });
  console.log(`[smoke] ready in ${Date.now() - started}ms`);

  if (!pool) {
    console.error('[smoke] factory returned in-memory graph — check DATABASE_URL');
    process.exit(1);
  }

  const scope = `smoke:${new Date().toISOString()}`;
  const scopeOther = `smoke-other:${new Date().toISOString()}`;
  const now = new Date();
  const userA = 'smoke-user-a';
  const userB = 'smoke-user-b';

  console.log('[smoke] ingesting turns for two users…');
  await graph.ingestTurn({
    scope,
    userId: userA,
    time: now.toISOString(),
    userMessage: 'hallo',
    assistantAnswer: 'hi',
    toolCalls: 0,
    iterations: 1,
    entityRefs: [
      {
        system: 'odoo',
        model: 'hr.employee',
        id: 42,
        displayName: 'Test Müller',
        op: 'read',
      },
    ],
  });
  await graph.ingestTurn({
    scope,
    userId: userA,
    time: new Date(now.getTime() + 1000).toISOString(),
    userMessage: 'und weiter?',
    assistantAnswer: 'weiter.',
    toolCalls: 1,
    iterations: 2,
    entityRefs: [
      {
        system: 'confluence',
        model: 'confluence.page',
        id: 'page-123',
        displayName: 'Playbook',
        op: 'read',
      },
    ],
  });
  await graph.ingestTurn({
    scope: scopeOther,
    userId: userB,
    time: new Date(now.getTime() + 2000).toISOString(),
    userMessage: 'hey',
    assistantAnswer: 'hallo',
    toolCalls: 0,
    iterations: 1,
    entityRefs: [],
  });

  const allSessions = await graph.listSessions();
  const userASessions = await graph.listSessions({ userId: userA });
  const userBSessions = await graph.listSessions({ userId: userB });
  const strangerSessions = await graph.listSessions({ userId: 'nobody' });
  console.log(
    `[smoke] sessions: total=${allSessions.length} userA=${userASessions.length} userB=${userBSessions.length} stranger=${strangerSessions.length}`,
  );
  if (
    userASessions.length !== 1 ||
    userBSessions.length !== 1 ||
    strangerSessions.length !== 0
  ) {
    throw new Error('user-scoped filter did not isolate sessions correctly');
  }

  const session = await graph.getSession(scope);
  console.log(
    `[smoke] session=${session ? 'ok' : 'MISSING'} turns=${session?.turns.length ?? 0}`,
  );

  const stats = await graph.stats();
  console.log(`[smoke] stats:`, JSON.stringify(stats));

  const sessions = await graph.listSessions();
  console.log(`[smoke] listSessions count=${sessions.length}`);

  console.log('[smoke] cleaning up test scopes…');
  await pool.query(
    `DELETE FROM graph_nodes
     WHERE tenant_id = $1
       AND (scope = ANY($2::text[]) OR external_id = ANY($3::text[]))`,
    [
      process.env['GRAPH_TENANT_ID'] ?? 'default',
      [scope, scopeOther],
      [`session:${scope}`, `session:${scopeOther}`],
    ],
  );

  await pool.end();
  console.log('[smoke] OK ✓');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
