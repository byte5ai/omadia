import { strict as assert } from 'node:assert';
import { after, describe, it, type TestContext } from 'node:test';

import { Pool } from 'pg';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { GraphNode, KnowledgeGraph } from '@omadia/plugin-api';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * `getNeighborsOfType` (plugin-api 1.98.0): the batched neighbour read the
 * bounded `findEntities` uses instead of one `getNeighbors` per hit (N+1).
 * Same answer as `getNeighbors` filtered by type, keyed by the requested id,
 * `[]` for an id with none or an unknown one; on Neon inside the tenant.
 *
 * Skipping is per test: this file also runs under the plain
 * `test/**\/*.test.ts` glob, where no database exists.
 */

const TENANT = 'kg-neighbors-of-type';
const OTHER_TENANT = 'kg-neighbors-of-type-other';
const PARTNER = 'odoo:res.partner:7';
const PROJECT = 'odoo:project.project:9';
const LONELY = 'odoo:res.partner:8';

async function seed(kg: KnowledgeGraph): Promise<void> {
  await kg.ingestEntities([{ system: 'odoo', model: 'res.partner', id: 8, displayName: 'Lonely' }]);
  for (const [scope, time] of [
    ['atlas::web-1', '2026-11-25T10:00:00.000Z'],
    ['atlas::web-2', '2026-11-25T11:00:00.000Z'],
  ] as const) {
    await kg.ingestTurn({
      scope,
      time,
      userMessage: 'Wie steht Kranich?',
      assistantAnswer: 'Kranich läuft.',
      entityRefs: [
        { system: 'odoo', model: 'res.partner', id: 7, displayName: 'Partner Seven', op: 'read' },
        { system: 'odoo', model: 'project.project', id: 9, displayName: 'Kranich', op: 'read' },
      ],
    });
  }
}

function runContract(label: string, graph: () => Promise<KnowledgeGraph | undefined>): void {
  describe(`getNeighborsOfType · ${label}`, () => {
    it('matches getNeighbors filtered by type, keyed by every requested id', async (t: TestContext) => {
      const kg = await graph();
      if (!kg?.getNeighborsOfType) return t.skip('backend not available');
      const ids = [PARTNER, PROJECT, LONELY, 'odoo:res.partner:404'];
      const batched = await kg.getNeighborsOfType(ids, 'Turn');
      assert.deepEqual([...batched.keys()].sort(), [...ids].sort());
      for (const id of ids) {
        const single: GraphNode[] = (await kg.getNeighbors(id)).filter((n: GraphNode) => n.type === 'Turn');
        assert.deepEqual(
          (batched.get(id) ?? []).map((n) => n.id).sort(),
          single.map((n) => n.id).sort(),
          id,
        );
      }
      assert.equal(batched.get(PARTNER)?.length, 2, 'both capturing turns, each once');
      assert.deepEqual(batched.get(LONELY), []);
      assert.deepEqual(batched.get('odoo:res.partner:404'), []);
    });

    it('returns only the requested type, and an empty map for no ids', async (t: TestContext) => {
      const kg = await graph();
      if (!kg?.getNeighborsOfType) return t.skip('backend not available');
      const sessions = await kg.getNeighborsOfType([PARTNER], 'Session');
      assert.deepEqual(sessions.get(PARTNER), []);
      assert.equal((await kg.getNeighborsOfType([], 'Turn')).size, 0);
    });
  });
}

let memory: Promise<KnowledgeGraph> | undefined;
runContract('InMemoryKnowledgeGraph', () => {
  memory ??= (async () => {
    const kg = new InMemoryKnowledgeGraph();
    await seed(kg);
    return kg;
  })();
  return memory;
});

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'kgNeighborsOfType',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function clear(p: Pool): Promise<void> {
  for (const tenant of [TENANT, OTHER_TENANT]) {
    await p.query('DELETE FROM graph_edges WHERE tenant_id = $1', [tenant]);
    await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [tenant]);
  }
}

let neon: Promise<{ kg: KnowledgeGraph; other: KnowledgeGraph }> | undefined;
function neonGraphs(): Promise<{ kg: KnowledgeGraph; other: KnowledgeGraph }> | undefined {
  if (!pool) return undefined;
  neon ??= (async () => {
    await runGraphMigrations(pool);
    await clear(pool);
    const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
    const other = new NeonKnowledgeGraph({ pool, tenantId: OTHER_TENANT });
    await seed(kg);
    return { kg, other };
  })();
  return neon;
}

after(async () => {
  if (!pool) return;
  await clear(pool);
  await pool.end();
});

runContract('NeonKnowledgeGraph (real PG)', async () => (await neonGraphs())?.kg);

describe('getNeighborsOfType — tenant scope · NeonKnowledgeGraph (real PG)', () => {
  it('reads the neighbours inside the calling tenant only', async (t) => {
    const g = neonGraphs();
    if (!g) return t.skip('no test database');
    const { other } = await g;
    const map = await other.getNeighborsOfType!([PARTNER], 'Turn');
    assert.deepEqual(map.get(PARTNER), []);
  });
});
