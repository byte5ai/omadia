/**
 * #1765 — `routineOwnerIdsForAccount` against the real graph schema: a login's
 * `web:<users.id>` identity resolves to the person's cluster id, and a second
 * web login of the same person keeps the routines with the person.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { NeonKnowledgeGraph, createNeonPool } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

import { routineOwnerIdsForAccount } from '../src/plugins/routines/accountRoutineOwner.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'issue1765-tenant';
let pool: Pool | undefined;
let reachable = false;

describe('#1765 · account → routine owner ids (pg)', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'accountRoutineOwner',
      vars: ['WS3_PG_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    try {
      await runGraphMigrations(pool);
      reachable = true;
    } catch {
      await pool.end().catch(() => undefined);
      pool = undefined;
    }
  });

  after(async () => {
    if (pool) {
      await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  it('resolves the only web login to the cluster, and keeps routines of a person with another login', async (t) => {
    if (!reachable || !pool) return t.skip('no pg');
    const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
    const anna = await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'users-anna', displayName: 'Anna', email: 'anna@example.com', emailVerified: true });
    assert.deepEqual(await routineOwnerIdsForAccount(pool, TENANT, 'users-anna'), ['users-anna', anna.omadiaUserId]);

    // Same person, second login (verified email merges into the cluster).
    const second = await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'users-anna-2', displayName: 'Anna', email: 'anna@example.com', emailVerified: true });
    assert.equal(second.omadiaUserId, anna.omadiaUserId);
    assert.deepEqual(await routineOwnerIdsForAccount(pool, TENANT, 'users-anna'), ['users-anna']);

    assert.deepEqual(await routineOwnerIdsForAccount(pool, TENANT, 'nobody'), ['nobody']);
  });
});
