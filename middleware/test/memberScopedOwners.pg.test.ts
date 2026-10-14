import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

// ---------------------------------------------------------------------------
// Member-scoped memory on the production backend: every read that can carry
// conversation knowledge into a turn honours `audienceOwners`
// (audience ⊆ owners) in SQL, exactly like the in-memory twin the orchestrator
// scenario tests use (`orchestrator/memberScopedMemory.test.ts`).
//
// Skips (loudly) without a reachable pgvector Postgres — see issue #572.
// ---------------------------------------------------------------------------

const TENANT = `member-owners-${Date.now()}`;
const GROUP = 'team-agent::msteams-conv-kranich';
// Canonical omadia user ids are uuids (`acl_owners` validates that).
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const P = randomUUID();

let pool: Pool | undefined;
let reachable = false;
const kg = (): NeonKnowledgeGraph => new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });

/** A unit vector — enough for the MK leg's `embedding IS NOT NULL` + cosine. */
const VECTOR = `[${Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;

describe('member-scoped memory · Neon owner filters', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'memberScopedOwners',
      vars: ['WS3_PG_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    try {
      await runGraphMigrations(pool);
      reachable = true;
      await kg().ingestTurn({
        scope: GROUP,
        time: '2026-10-06T09:00:00.000Z',
        userMessage: 'Projekt Kranich Budget 4,2 Mio',
        assistantAnswer: 'Notiert.',
        entityRefs: [{ system: 'odoo', model: 'project.project', id: 7, displayName: 'Kranich', op: 'read' }],
        owners: [C, A, B, A],
      });
      // A legacy turn without owners: never visible to an audience.
      await kg().ingestTurn({
        scope: GROUP,
        time: '2026-10-06T08:00:00.000Z',
        userMessage: 'Kranich Budget alt',
        assistantAnswer: 'ok',
        entityRefs: [],
      });
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

  it('stores owners canonical: de-duplicated and sorted', async (t) => {
    if (!reachable) return t.skip('no pg');
    const row = await pool!.query<{ owners: string[] }>(
      `SELECT properties->'owners' AS owners FROM graph_nodes
        WHERE tenant_id = $1 AND type = 'Turn' AND properties ? 'owners'`,
      [TENANT],
    );
    assert.deepEqual(row.rows[0]?.owners, [A, B, C].sort());
  });

  it('searchTurns: a subset of the owners sees it; a superset or stranger does not', async (t) => {
    if (!reachable) return t.skip('no pg');
    const search = async (audience: string[]): Promise<number> =>
      (await kg().searchTurns({ query: 'Kranich Budget', audienceOwners: audience, limit: 10 })).length;
    assert.equal(await search([A]), 1, 'one owner alone');
    assert.equal(await search([B, C]), 1, 'two owners');
    assert.equal(await search([A, B, C, P]), 0, 'owners plus a newcomer');
    assert.equal(await search([P]), 0, 'a stranger');
    assert.equal(await search([]), 0, 'an empty audience matches nothing');
    assert.equal(
      (await kg().searchTurns({ query: 'Kranich Budget', limit: 10 })).length,
      2,
      'CONTROL: without an audience both turns match',
    );
  });

  it('findEntityCapturedTurns honours the audience', async (t) => {
    if (!reachable) return t.skip('no pg');
    const owners = await kg().findEntityCapturedTurns({ terms: ['Kranich'], audienceOwners: [A, B] });
    const stranger = await kg().findEntityCapturedTurns({ terms: ['Kranich'], audienceOwners: [P] });
    assert.equal(owners[0]?.turns.length, 1);
    assert.equal(stranger.length, 0);
  });

  it('getSession (the context tail) keeps only turns the audience owns', async (t) => {
    if (!reachable) return t.skip('no pg');
    assert.equal((await kg().getSession(GROUP))?.turns.length, 2, 'CONTROL: unfiltered');
    assert.equal((await kg().getSession(GROUP, { audienceOwners: [A] }))?.turns.length, 1);
    assert.equal(await kg().getSession(GROUP, { audienceOwners: [A, P] }), null);
  });

  it('memorable knowledge: owned by the room, or operator-authored', async (t) => {
    if (!reachable) return t.skip('no pg');
    const make = async (
      summary: string,
      aclOwners: string[],
      manual: boolean,
      createdBy = 'operator:test',
    ): Promise<void> => {
      const { memorableKnowledgeNodeId } = await kg().createMemorableKnowledge({
        kind: 'reference',
        summary,
        createdBy,
        aclOwners,
        visibility: 'team',
      });
      await pool!.query(
        `UPDATE graph_nodes SET embedding = $3::vector, manually_authored = $4
          WHERE tenant_id = $1 AND external_id = $2`,
        [TENANT, memorableKnowledgeNodeId, VECTOR, manual],
      );
    };
    await make('group fact', [A, B, C], false);
    await make('team-visible but from another room', [P], false);
    await make('operator rule', [], true);
    // T3 durable auto-promotion marks a conversation row manually_authored too.
    await make('auto-durable from another room', [P], true, `auto:${P}`);
    const search = async (audience: string[]): Promise<string[]> =>
      (
        await kg().searchMemorableKnowledgeByEmbedding({
          queryEmbedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
          viewerOmadiaUserId: audience[0]!,
          teamVisibility: true,
          audienceOwners: audience,
          limit: 10,
          minSimilarity: 0.1,
        })
      )
        .map((h) => String(h.mk.props['summary']))
        .sort();
    assert.deepEqual(await search([A, C]), ['group fact', 'operator rule']);
    assert.deepEqual(await search([A, P]), ['operator rule'], 'team visibility must not widen the room rule');
  });
});
