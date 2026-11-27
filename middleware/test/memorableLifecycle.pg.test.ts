/**
 * ADR-0190 — memorable-knowledge lifecycle on real Postgres
 * (`NeonKnowledgeGraph` + bulk promotion):
 *  - deleting an entry retires its source turn and closes its open pairs;
 *  - a resolution that keeps a deleted side is refused (`keeper_missing`);
 *  - bulk promotion skips retired turns and turns no person owns (Public API
 *    `key:<id>`), and creates entries like live auto-promotion (excerpt,
 *    origin agent);
 *  - a lost contradiction verdict records an attempt, moves the entry behind
 *    never-attempted ones and gives up after INCONSISTENCY_MAX_LOST_VERDICTS.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { createBulkPromotionService } from '@omadia/orchestrator-extras';
import {
  INCONSISTENCY_MAX_LOST_VERDICTS,
  PROMOTION_RETIRED_PROP,
  type PalaiaExcerptExtractor,
} from '@omadia/plugin-api';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'memorable-lifecycle';
const OWNER = '33333333-3333-4333-8333-333333333333';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memorableLifecycle',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function clean(p: Pool): Promise<void> {
  await p.query('DELETE FROM graph_edges WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM memory_acl_audit WHERE tenant_id = $1', [TENANT]);
}

async function propsOf(p: Pool, externalId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await p.query<{ properties: Record<string, unknown> }>(
    'SELECT properties FROM graph_nodes WHERE tenant_id = $1 AND external_id = $2',
    [TENANT, externalId],
  );
  return rows[0]?.properties;
}

async function embeddingDims(p: Pool): Promise<number> {
  const { rows } = await p.query<{ dims: number | null }>(
    `SELECT atttypmod AS dims FROM pg_attribute
      WHERE attrelid = 'graph_nodes'::regclass AND attname = 'embedding'`,
  );
  const dims = rows[0]?.dims ?? -1;
  return dims > 0 ? dims : 768;
}

async function turn(
  kg: NeonKnowledgeGraph,
  p: Pool,
  opts: { scope: string; userId: string; time: string; text: string; significance: number },
): Promise<string> {
  const { turnId } = await kg.ingestTurn({
    scope: opts.scope,
    userId: opts.userId,
    time: opts.time,
    userMessage: opts.text,
    assistantAnswer: `Notiert: ${opts.text}`,
    entityRefs: [],
  });
  await p.query(
    `UPDATE graph_nodes SET significance = $3 WHERE tenant_id = $1 AND external_id = $2`,
    [TENANT, turnId, opts.significance],
  );
  return turnId;
}

describe('ADR-0190 memorable lifecycle (real PG)', { skip: !pool }, () => {
  const ready = (async () => {
    if (!pool) return undefined;
    await runGraphMigrations(pool);
    await clean(pool);
    return new NeonKnowledgeGraph({ pool, tenantId: TENANT });
  })();

  after(async () => {
    if (pool) {
      await clean(pool);
      await pool.end();
    }
  });

  it('lost verdicts queue the entry last and give up after the limit', async () => {
    const kg = await ready;
    assert.ok(kg && pool);
    await clean(pool);
    const mk = async (summary: string): Promise<string> => {
      const created = await kg.createMemorableKnowledge({
        kind: 'reference',
        summary,
        createdBy: `auto:${OWNER}`,
        involvedOmadiaUserIds: [OWNER],
        aclOwners: [OWNER],
      });
      const id = created.memorableKnowledgeNodeId;
      await pool.query(
        `UPDATE graph_nodes
            SET embedding = (SELECT ('[' || string_agg('0.1', ',') || ']')::vector
                               FROM generate_series(1, $3::int))
          WHERE tenant_id = $1 AND external_id = $2`,
        [TENANT, id, await embeddingDims(pool)],
      );
      return id;
    };
    const stuck = await mk('Wartung Ibis am Montag.');
    const fresh = await mk('Wartung Reiher am Dienstag.');
    await kg.markMemorableKnowledgeInconsistencyChecked(stuck, { verdictLost: true });
    assert.deepEqual(
      await kg.listMemorableKnowledgeIdsForBulkInconsistencyCheck({ limit: 1 }),
      [fresh],
      'a never-attempted entry goes first',
    );
    for (let i = 1; i < INCONSISTENCY_MAX_LOST_VERDICTS; i++) {
      await kg.markMemorableKnowledgeInconsistencyChecked(stuck, { verdictLost: true });
    }
    const props = await propsOf(pool, stuck);
    assert.equal(props?.['inconsistency_lost_verdicts'], INCONSISTENCY_MAX_LOST_VERDICTS);
    assert.equal(props?.['inconsistency_check_outcome'], 'verdict_lost');
    assert.ok(props?.['last_inconsistency_check_at'], 'marked checked after the limit');
    assert.deepEqual(
      await kg.listMemorableKnowledgeIdsForBulkInconsistencyCheck({ limit: 10 }),
      [fresh],
    );
  });

  it('delete retires the source turn and closes open pairs; keeping a deleted side is refused', async () => {
    const kg = await ready;
    assert.ok(kg && pool);
    const turnId = await turn(kg, pool, {
      scope: 'palaia::talk-a',
      userId: OWNER,
      time: '2026-11-10T09:00:00.000Z',
      text: 'Test server Ibis has 64 GB of RAM.',
      significance: 0.9,
    });
    const a = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'Test server Ibis has 64 GB of RAM.',
      createdBy: `auto:${OWNER}`,
      involvedOmadiaUserIds: [OWNER],
      aclOwners: [OWNER],
      derivedFromTurnIds: [turnId],
    });
    const b = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'Test server Ibis has 8 GB of RAM.',
      createdBy: `web:${OWNER}`,
      involvedOmadiaUserIds: [OWNER],
      aclOwners: [OWNER],
    });
    const aId = a.memorableKnowledgeNodeId;
    const bId = b.memorableKnowledgeNodeId;
    const inc = await kg.createInconsistency({ mkAExternalId: aId, mkBExternalId: bId, summary: 'RAM', severity: 'high' });
    const dup = await kg.createMergeCandidate({ mkAExternalId: aId, mkBExternalId: bId, cosineSim: 0.93 });
    assert.ok(inc && dup);

    await kg.deleteMemory(aId, { actorOmadiaUserId: OWNER });

    const turnProps = await propsOf(pool, turnId);
    assert.equal((turnProps?.[PROMOTION_RETIRED_PROP] as { reason?: string })?.reason, 'memory_deleted');
    const incProps = await propsOf(pool, inc.id);
    assert.equal(incProps?.['status'], 'dismissed');
    assert.equal(incProps?.['closed_reason'], 'memory_deleted');
    assert.equal(incProps?.['resolved_by'], OWNER);
    assert.equal((await propsOf(pool, dup.id))?.['status'], 'dismissed');

    // Re-open the pair as a pre-fix row would be, then try to keep the gone side.
    await pool.query(
      `UPDATE graph_nodes SET properties = properties || '{"status":"open"}'::jsonb
        WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT, inc.id],
    );
    const keepGone = inc.conflictsWith[0] === aId ? 'a_wins' : 'b_wins';
    await assert.rejects(
      kg.resolveInconsistency(inc.id, keepGone, { actorOmadiaUserId: OWNER }),
      (err: unknown) => (err as { code?: string }).code === 'keeper_missing',
    );
    assert.ok(await kg.getMemorableKnowledge(bId), 'the last copy survives');
  });

  it('bulk promotion skips retired and ownerless turns and promotes like live', async () => {
    const kg = await ready;
    assert.ok(kg && pool);
    await clean(pool);
    const retiredTurn = await turn(kg, pool, {
      scope: 'palaia::talk-b',
      userId: OWNER,
      time: '2026-11-10T10:00:00.000Z',
      text: 'Projekt Zebra startet am 10. November.',
      significance: 0.95,
    });
    await pool.query(
      `UPDATE graph_nodes
          SET properties = properties || jsonb_build_object('${PROMOTION_RETIRED_PROP}', '{"reason":"memory_deleted"}'::jsonb)
        WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT, retiredTurn],
    );
    await turn(kg, pool, {
      scope: 'api::key-1',
      userId: 'key:0d8f0b0e-1111-4111-8111-111111111111',
      time: '2026-11-10T11:00:00.000Z',
      text: 'We moved the Q3 release to 15 September.',
      significance: 0.99,
    });
    const liveTurn = await turn(kg, pool, {
      scope: 'palaia::talk-c',
      userId: OWNER,
      time: '2026-11-10T12:00:00.000Z',
      text: 'Die Rechnungen gehen ab Dezember über Lexware raus.',
      significance: 0.8,
    });

    const extractor: PalaiaExcerptExtractor = {
      async extract() {
        return {
          suggestedKind: 'decision',
          suggestedSummary: 'Rechnungen laufen ab Dezember über Lexware.',
          excerpts: ['Die Rechnungen gehen ab Dezember über Lexware raus.'],
          source: 'llm',
        };
      },
    };
    const service = createBulkPromotionService({
      pool,
      tenantId: TENANT,
      kg,
      scorer: { async score() { return { score: 0.5 }; } },
      excerptExtractor: extractor,
      log: () => {},
    });

    const preview = await service.preview(0.7);
    assert.equal(preview.eligibleForPromoteCount, 1, 'only the promotable turn is eligible');

    const result = await service.run({ promoteLimit: 5, threshold: 0.7 });
    assert.equal(result.promotePhase.scanned, 1);
    assert.equal(result.promotePhase.promoted, 1);
    assert.equal(result.promotePhase.failed, 0);

    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      `SELECT mk.properties
         FROM graph_edges e
         JOIN graph_nodes mk ON mk.id = e.from_node
         JOIN graph_nodes t ON t.id = e.to_node
        WHERE e.tenant_id = $1 AND e.type = 'DERIVED_FROM' AND t.external_id = $2`,
      [TENANT, liveTurn],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.properties['origin_agent'], 'palaia');
    assert.equal(rows[0]?.properties['kind'], 'decision');
    assert.equal(rows[0]?.properties['summary'], 'Rechnungen laufen ab Dezember über Lexware.');
  });
});
