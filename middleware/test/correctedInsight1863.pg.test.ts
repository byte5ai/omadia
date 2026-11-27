/**
 * #1863 on the Neon backend (real pgvector Postgres; skipped without one): a
 * content edit through `updateMemorableKnowledge` stamps `corrected_at`, which
 * passes the MemorableKnowledge props schema; a significance-only patch does
 * not stamp it.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { MEMORY_CORRECTED_AT_PROP } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = `corrected-insight-${Date.now()}`;
const OWNER = '44444444-4444-4444-8444-444444444444';

let pool: Pool | undefined;
let reachable = false;
const kg = (): NeonKnowledgeGraph => new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });

describe('updateMemorableKnowledge stamps a user correction (#1863, real PG)', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'correctedInsight1863',
      vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    await runGraphMigrations(pool);
    reachable = true;
  });

  after(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM memory_acl_audit WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.query('DELETE FROM graph_edges WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it('a summary edit sets corrected_at, a significance patch does not', async (t) => {
    if (!reachable) return t.skip('no pg');
    const created = await kg().createMemorableKnowledge({
      kind: 'reference',
      summary: 'Projekt Storch startet am 7. Dezember.',
      createdBy: 'web:owner',
      involvedOmadiaUserIds: [],
      aclOwners: [OWNER],
    });
    const id = created.memorableKnowledgeNodeId;

    await kg().updateMemorableKnowledge(id, { significance: 0.7 }, { actorOmadiaUserId: OWNER });
    const rescored = await kg().getMemorableKnowledge(id, OWNER);
    assert.equal(rescored?.props[MEMORY_CORRECTED_AT_PROP], undefined);

    const updated = await kg().updateMemorableKnowledge(
      id,
      { summary: 'Projekt Storch startet am 14. Dezember.' },
      { actorOmadiaUserId: OWNER },
    );
    const stamp = updated.props[MEMORY_CORRECTED_AT_PROP];
    assert.equal(typeof stamp, 'string');
    assert.ok(Math.abs(Date.parse(String(stamp)) - Date.now()) < 60_000);
  });
});
