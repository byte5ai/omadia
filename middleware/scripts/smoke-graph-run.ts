/**
 * Smoke test for the agentic run-graph (ingestRun against Neon).
 * Ingests one Turn, then a richer Run trace with one orchestrator-level
 * tool call and two agent invocations (one success, one error with a
 * failing sub-tool). Verifies node/edge counts after each step and
 * cleans up.
 */
import 'dotenv/config';

import { createKnowledgeGraph } from '../src/services/graph/index.js';
import {
  runNodeId,
  turnNodeId,
  userNodeId,
  type RunTrace,
} from '../src/services/knowledgeGraph.js';

async function main(): Promise<void> {
  const { graph, pool } = await createKnowledgeGraph({
    log: (msg) => console.log(msg),
  });
  if (!pool) {
    console.error('[smoke] DATABASE_URL not set');
    process.exit(1);
  }

  const scope = `smoke-run:${new Date().toISOString()}`;
  const userId = 'smoke-user-run';
  const turnTime = new Date().toISOString();
  const turnExtId = turnNodeId(scope, turnTime);
  const runExtId = runNodeId(turnExtId);
  const userExtId = userNodeId(userId);

  console.log('[smoke] ingesting Turn first…');
  await graph.ingestTurn({
    scope,
    userId,
    time: turnTime,
    userMessage: 'Wie viele offene Rechnungen hat Kunde X?',
    assistantAnswer: 'Drei offene Rechnungen, Summe 4.200 €.',
    toolCalls: 3,
    iterations: 2,
    entityRefs: [
      {
        system: 'odoo',
        model: 'account.move',
        id: 4711,
        displayName: 'INV/2026/0042',
        op: 'read',
      },
    ],
  });

  const trace: RunTrace = {
    turnId: turnExtId,
    scope,
    userId,
    startedAt: turnTime,
    finishedAt: new Date(Date.parse(turnTime) + 2500).toISOString(),
    durationMs: 2500,
    status: 'success',
    iterations: 2,
    orchestratorToolCalls: [
      {
        callId: 'toolu_orch_01',
        toolName: 'query_knowledge_graph',
        durationMs: 42,
        isError: false,
        agentContext: 'orchestrator',
      },
    ],
    agentInvocations: [
      {
        index: 0,
        agentName: 'query_odoo_accounting',
        durationMs: 1600,
        subIterations: 3,
        status: 'success',
        toolCalls: [
          {
            callId: 'toolu_sub_01',
            toolName: 'odoo_execute',
            durationMs: 400,
            isError: false,
            agentContext: 'query_odoo_accounting',
            producedEntityIds: ['odoo:account.move:4711'],
          },
          {
            callId: 'toolu_sub_02',
            toolName: 'odoo_execute',
            durationMs: 180,
            isError: false,
            agentContext: 'query_odoo_accounting',
          },
        ],
      },
      {
        index: 1,
        agentName: 'query_confluence_playbook',
        durationMs: 700,
        subIterations: 1,
        status: 'error',
        toolCalls: [
          {
            callId: 'toolu_sub_03',
            toolName: 'confluence_search',
            durationMs: 680,
            isError: true,
            agentContext: 'query_confluence_playbook',
          },
        ],
      },
    ],
  };

  console.log('[smoke] ingesting Run trace…');
  const result = await graph.ingestRun(trace);
  console.log(`[smoke] run: runId=${result.runId}`);
  console.log(
    `[smoke]      agentInvocations=${String(result.agentInvocationIds.length)} toolCalls=${String(result.toolCallIds.length)}`,
  );

  const stats = await graph.stats();
  console.log('[smoke] stats:', JSON.stringify(stats));

  if (
    stats.byNodeType.Run < 1 ||
    stats.byNodeType.AgentInvocation < 2 ||
    stats.byNodeType.ToolCall < 4 ||
    stats.byNodeType.User < 1
  ) {
    throw new Error('expected new agentic nodes not present');
  }
  if (
    stats.byEdgeType.EXECUTED < 1 ||
    stats.byEdgeType.INVOKED_AGENT < 2 ||
    stats.byEdgeType.INVOKED_TOOL < 4 ||
    stats.byEdgeType.BELONGS_TO < 1 ||
    stats.byEdgeType.PRODUCED < 1
  ) {
    throw new Error('expected new agentic edges not present');
  }

  console.log('[smoke] cleaning up…');
  const tenant = process.env['GRAPH_TENANT_ID'] ?? 'default';
  await pool.query(
    `DELETE FROM graph_nodes
     WHERE tenant_id = $1
       AND (external_id = ANY($2::text[]) OR scope = $3 OR (type = 'User' AND external_id = $4))`,
    [
      tenant,
      [
        `session:${scope}`,
        turnExtId,
        runExtId,
        'odoo:account.move:4711',
      ],
      scope,
      userExtId,
    ],
  );

  await pool.end();
  console.log('[smoke] OK ✓');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
