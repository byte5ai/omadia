import 'dotenv/config';
import { createKnowledgeGraph } from '../src/services/graph/index.js';
import { turnNodeId } from '../src/services/knowledgeGraph.js';

const { graph, pool } = await createKnowledgeGraph({ log: () => undefined });
if (!pool) {
  console.error('no pool');
  process.exit(1);
}

const scope = 'e2e-verify';
const userId = 'e2e-user';
const time = new Date().toISOString();
const turnExtId = turnNodeId(scope, time);

await graph.ingestTurn({
  scope,
  userId,
  time,
  userMessage: 'E2E Verify',
  assistantAnswer: 'OK',
  toolCalls: 2,
  iterations: 1,
  entityRefs: [
    {
      system: 'odoo',
      model: 'hr.employee',
      id: 999,
      displayName: 'E2E Mueller',
      op: 'read',
    },
  ],
});

await graph.ingestRun({
  turnId: turnExtId,
  scope,
  userId,
  startedAt: time,
  finishedAt: new Date(Date.parse(time) + 1200).toISOString(),
  durationMs: 1200,
  status: 'success',
  iterations: 1,
  orchestratorToolCalls: [
    {
      callId: 'orch-1',
      toolName: 'query_knowledge_graph',
      durationMs: 30,
      isError: false,
      agentContext: 'orchestrator',
    },
  ],
  agentInvocations: [
    {
      index: 0,
      agentName: 'query_odoo_hr',
      durationMs: 900,
      subIterations: 2,
      status: 'success',
      toolCalls: [
        {
          callId: 'sub-1',
          toolName: 'odoo_execute',
          durationMs: 420,
          isError: false,
          agentContext: 'query_odoo_hr',
          producedEntityIds: ['odoo:hr.employee:999'],
        },
      ],
    },
  ],
});

console.log(JSON.stringify({ turnExtId }));
await pool.end();
