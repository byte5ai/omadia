import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

// ---------------------------------------------------------------------------
// #1821 on the production backend: `addOwner` refuses an unknown user and
// writes the INVOLVED edge, so the new owner lists the entry;
// `removeOwner` drops the edge again. Twin of `memoryRoutesOwners.test.ts`.
// ---------------------------------------------------------------------------

const TENANT = `owners-involved-${Date.now()}`;
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

let pool: Pool | undefined;
let reachable = false;
const kg = (): NeonKnowledgeGraph => new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });

describe('#1821 · Neon addOwner / removeOwner keep INVOLVED in step', () => {
  let anna = '';
  let ben = '';

  before(async () => {
    const probe = await probePgTest({
      label: 'memoryOwnersInvolved',
      vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    await runGraphMigrations(pool);
    const user = async (name: string): Promise<string> =>
      (
        await kg().resolveOrCreateChannelIdentity({
          channelKind: 'teams',
          channelUserId: `aad-${name}`,
          aadObjectId: `aad-${name}`,
          displayName: name,
        })
      ).omadiaUserId;
    anna = await user('anna');
    ben = await user('ben');
    reachable = true;
  });

  after(async () => {
    if (pool) {
      await pool.query(`DELETE FROM memory_acl_audit WHERE tenant_id = $1`, [TENANT]).catch(() => undefined);
      await pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT]).catch(() => undefined);
      await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]).catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  it('refuses an unknown user, lists the entry for a real new owner, drops it on remove', async (t) => {
    if (!reachable) return t.skip('no pg');
    const { memorableKnowledgeNodeId: id } = await kg().createMemorableKnowledge({
      kind: 'reference',
      summary: 'Projekt Zebra startet am 10. November.',
      createdBy: `web:${anna}`,
      actorOmadiaUserId: anna,
      aclOwners: [anna],
      involvedOmadiaUserIds: [anna],
    });
    const actor = { actorOmadiaUserId: anna };

    await assert.rejects(
      () => kg().addOwner(id, UNKNOWN, actor),
      (err: unknown) => (err as { code?: string }).code === 'user_not_found',
    );
    assert.deepEqual((await kg().getMemorableKnowledge(id))!.props['acl_owners'], [anna]);

    const lists = async (who: string): Promise<boolean> =>
      (await kg().listMemorableKnowledgeFor(who)).some((n) => n.id === id);
    assert.equal(await lists(ben), false);
    assert.deepEqual(await kg().addOwner(id, ben, actor), [anna, ben]);
    assert.equal(await lists(ben), true, 'the new owner lists it');

    await kg().removeOwner(id, ben, actor);
    assert.equal(await lists(ben), false, 'gone after remove');
    assert.equal(await lists(anna), true);
  });
});
