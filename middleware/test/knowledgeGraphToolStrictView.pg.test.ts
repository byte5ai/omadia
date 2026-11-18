import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { KnowledgeGraphTool } from '@omadia/orchestrator';
import type { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

// ---------------------------------------------------------------------------
// The `enforce-strict` view of `query_knowledge_graph` against the production
// backend. The in-memory twin is covered by `knowledgeGraphToolStrictView.test.ts`;
// here the search pre-filter is SQL (`scope LIKE $prefix || '%'`), so the two
// things worth proving on Postgres are that the own conversation is found and
// that a scope merely STARTING with the own one is not.
//
// Skips (loudly) without a reachable pgvector Postgres — see issue #572.
// ---------------------------------------------------------------------------

const TENANT = `kg-strict-view-${Date.now()}`;
const OWN = 'agent-x::telegram::-1001';
const OTHER = 'agent-x::msteams::conv-kranich';
const OWN_PREFIXED = `${OWN}0`;

let pool: Pool | undefined;
let reachable = false;

describe('KnowledgeGraphTool — enforce-strict view on Neon', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'knowledgeGraphToolStrictView',
      vars: ['WS3_PG_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    try {
      await runGraphMigrations(pool);
      reachable = true;
      const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
      for (const [scope, time, text] of [
        [OTHER, '2026-10-05T09:00:00.000Z', 'Kranich Budget 4,2 Mio'],
        [OWN, '2026-10-05T10:00:00.000Z', 'Kranich Termin Freitag'],
        [OWN_PREFIXED, '2026-10-05T11:00:00.000Z', 'Kranich Budget Nachbar'],
      ] as const) {
        await kg.ingestTurn({ scope, time, userMessage: text, assistantAnswer: 'ok', entityRefs: [] });
      }
    } catch {
      reachable = false;
    }
  });

  after(async () => {
    if (pool) {
      await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]).catch(() => undefined);
      await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]).catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  const tool = (): KnowledgeGraphTool =>
    new KnowledgeGraphTool(new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT }));

  it('search_turns returns the own conversation only', async (t) => {
    if (!reachable) return t.skip('no pg');
    const out = JSON.parse(
      await tool().handle({ query: 'search_turns', text: 'Kranich' }, { restrictToScope: OWN }),
    ) as { hits: Array<{ scope: string; userMessage: string }> };
    assert.deepEqual(out.hits.map((h) => h.scope), [OWN]);
    assert.ok(!out.hits.some((h) => h.userMessage.includes('4,2 Mio')));
  });

  it('CONTROL: without a view the search reaches the other conversation', async (t) => {
    if (!reachable) return t.skip('no pg');
    const out = JSON.parse(await tool().handle({ query: 'search_turns', text: 'Kranich' })) as {
      hits: Array<{ scope: string }>;
    };
    assert.ok(out.hits.some((h) => h.scope === OTHER));
  });

  it('list_sessions and session_summary stay inside the own conversation', async (t) => {
    if (!reachable) return t.skip('no pg');
    const sessions = JSON.parse(
      await tool().handle({ query: 'list_sessions' }, { restrictToScope: OWN }),
    ) as { sessions: Array<{ scope: string }> };
    assert.deepEqual(sessions.sessions.map((s) => s.scope), [OWN]);
    const other = JSON.parse(
      await tool().handle({ query: 'session_summary', scope: OTHER }, { restrictToScope: OWN }),
    ) as { error?: string };
    assert.equal(other.error, 'not_found');
  });
});
