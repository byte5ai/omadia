/**
 * #1096 — the SQL half of the tail-only contract.
 *
 * A sub-threshold turn is still written (so the session tail can read it) but
 * flagged `tailOnly`, and every knowledge path must skip it: the three
 * cross-session recall queries, the embedding (at ingest and in the backfill
 * sweep) and both promotion paths. The in-memory backend is covered by
 * `contextTailIndependence.test.ts`; production runs Neon, whose filters live
 * in SQL a fake pool never evaluates. So this suite records the SQL each path
 * issues and asserts the predicate is in it — comments stripped, so a
 * commented-out filter does not count. Dropping one of them would otherwise
 * let "ok"/"danke" chatter into cross-session recall with every test green.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';
import { startEmbeddingBackfill } from '@omadia/knowledge-graph-neon/dist/embeddingBackfill.js';
import { createBulkPromotionService } from '@omadia/orchestrator-extras/dist/bulkPromotion.js';
import { promoteTurnIfSignificant } from '@omadia/orchestrator-extras/dist/promotion.js';
import type { KnowledgeGraph, TurnIngest } from '@omadia/plugin-api';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

/** Answers a query with rows; unmatched queries get an empty result. */
type Responder = (sql: string) => ReadonlyArray<Record<string, unknown>> | undefined;

function recordingPool(respond: Responder = () => undefined): {
  pool: Pool;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const query = async (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<QueryResult> => {
    queries.push({ sql, params: params ?? [] });
    const rows = [...(respond(sql) ?? [])];
    return {
      command: '',
      rowCount: rows.length,
      oid: 0,
      rows,
      fields: [],
    } as unknown as QueryResult;
  };
  const pool = {
    query,
    async connect(): Promise<PoolClient> {
      return { query, release: (): void => {} } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, queries };
}

/** SQL without `--` comments: only live predicates count. */
function code(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

const EXCLUDES_TAIL_ONLY =
  /COALESCE\(\((?:t\.)?properties->>'tailOnly'\)::boolean, FALSE\) = FALSE/;

function assertExcludesTailOnly(q: CapturedQuery | undefined, what: string): void {
  assert.ok(q, `${what}: query was issued`);
  assert.ok(
    EXCLUDES_TAIL_ONLY.test(code(q.sql)),
    `${what}: must filter out tail-only Turns`,
  );
}

function turnSelects(queries: ReadonlyArray<CapturedQuery>): CapturedQuery[] {
  return queries.filter((q) => /type = 'Turn'/.test(q.sql));
}

describe('#1096 Neon recall queries exclude tail-only Turns', () => {
  it('searchTurns', async () => {
    const { pool, queries } = recordingPool();
    const kg = new NeonKnowledgeGraph({ pool, tenantId: 't1' });
    await kg.searchTurns({ query: 'blau', excludeScope: 's-other' });
    const selects = turnSelects(queries);
    assert.equal(selects.length, 1);
    assertExcludesTailOnly(selects[0], 'searchTurns');
  });

  it('searchTurnsByEmbedding (hybrid leg)', async () => {
    const { pool, queries } = recordingPool();
    const kg = new NeonKnowledgeGraph({ pool, tenantId: 't1' });
    await kg.searchTurnsByEmbedding({
      queryEmbedding: [0.1, 0.2, 0.3],
      ftsQuery: 'blau',
      excludeScope: 's-other',
    });
    const selects = turnSelects(queries);
    assert.equal(selects.length, 1);
    assertExcludesTailOnly(selects[0], 'searchTurnsByEmbedding');
  });

  it('findEntityCapturedTurns', async () => {
    // One matching entity, so the per-entity Turn query is actually reached.
    const { pool, queries } = recordingPool((sql) =>
      /type IN \('OdooEntity', 'ConfluencePage'\)/.test(sql)
        ? [
            {
              id: 'uuid-entity',
              external_id: 'odoo:res.partner:42',
              type: 'OdooEntity',
              scope: null,
              properties: { displayName: 'Lilium GmbH' },
            },
          ]
        : undefined,
    );
    const kg = new NeonKnowledgeGraph({ pool, tenantId: 't1' });
    await kg.findEntityCapturedTurns({ terms: ['lilium'], excludeScope: 's-other' });
    const selects = turnSelects(queries);
    assert.equal(selects.length, 1, 'the CAPTURED-edge Turn query ran');
    assertExcludesTailOnly(selects[0], 'findEntityCapturedTurns');
  });
});

describe('#1096 Neon embeddings skip tail-only Turns', () => {
  function ingestingKg(): {
    kg: NeonKnowledgeGraph;
    queries: CapturedQuery[];
    embedded: string[];
  } {
    const { pool, queries } = recordingPool((sql) =>
      /INSERT INTO graph_nodes/.test(sql) ? [{ id: 'uuid-node' }] : undefined,
    );
    const embedded: string[] = [];
    const client = {
      embed: async (text: string): Promise<number[]> => {
        embedded.push(text);
        return [0.1, 0.2, 0.3];
      },
    };
    const kg = new NeonKnowledgeGraph({
      pool,
      tenantId: 't1',
      resolveEmbeddingClient: () => client as never,
    });
    return { kg, queries, embedded };
  }

  function ingest(tailOnly: boolean): TurnIngest {
    return {
      scope: 's-embed',
      time: '2026-09-22T08:01:00.000Z',
      userMessage: 'ok',
      assistantAnswer: 'ok',
      entityRefs: [],
      ...(tailOnly ? { tailOnly: true } : {}),
    };
  }

  /** `ingestTurn` embeds fire-and-forget after COMMIT — let it settle. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  it('ingestTurn writes no embedding for a tail-only Turn', async () => {
    const { kg, embedded } = ingestingKg();
    await kg.ingestTurn(ingest(true));
    await settle();
    assert.deepEqual(embedded, [], 'no provider call for a tail-only turn');
  });

  it('ingestTurn still embeds an ordinary Turn (control)', async () => {
    const { kg, embedded } = ingestingKg();
    await kg.ingestTurn(ingest(false));
    await settle();
    assert.equal(embedded.length, 1);
  });

  it('ingestTurn persists the flag, including false', async () => {
    // Props MERGE on upsert: an omitted `false` would strand a stale `true`.
    for (const flag of [true, false]) {
      const { kg, queries } = ingestingKg();
      await kg.ingestTurn(ingest(flag));
      await settle();
      const turnInsert = queries.find(
        (q) => /INSERT INTO graph_nodes/.test(q.sql) && q.params[1] === 'Turn',
      );
      assert.ok(turnInsert, 'Turn upsert was issued');
      const props = JSON.parse(String(turnInsert.params[5])) as Record<string, unknown>;
      assert.equal(props['tailOnly'], flag);
    }
  });

  it('the backfill sweep does not pick tail-only Turns up', async () => {
    const { pool, queries } = recordingPool();
    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: { embed: async (): Promise<number[]> => [0.1] } as never,
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      log: () => {},
    });
    try {
      await handle.runOnce();
    } finally {
      handle.stop();
    }
    const sweep = queries.find((q) => /embedding IS NULL/.test(q.sql));
    assertExcludesTailOnly(sweep, 'embedding backfill sweep');
  });
});

describe('#1096 promotion paths decline tail-only Turns in SQL', () => {
  const kg = {} as KnowledgeGraph;

  it('bulk preview counts no tail-only Turn as a candidate', async () => {
    const { pool, queries } = recordingPool();
    const service = createBulkPromotionService({ pool, tenantId: 't1', kg, log: () => {} });
    await service.preview(0.7);
    assert.equal(queries.length, 3);
    assertExcludesTailOnly(queries[0], 'preview: unscored count');
    assertExcludesTailOnly(queries[1], 'preview: eligible count');
    assertExcludesTailOnly(queries[2], 'preview: already-promoted count');
  });

  it('bulk run neither scores nor promotes a tail-only Turn', async () => {
    const { pool, queries } = recordingPool();
    const service = createBulkPromotionService({
      pool,
      tenantId: 't1',
      kg,
      scorer: { score: async () => ({ score: 0.9 }) },
      log: () => {},
    });
    await service.run();
    const score = queries.find((q) => /significance IS NULL/.test(q.sql));
    const promote = queries.find((q) => /t\.significance >= \$2/.test(q.sql));
    assertExcludesTailOnly(score, 'run: score phase');
    assertExcludesTailOnly(promote, 'run: promote phase');
  });

  it('per-turn promotion reads the flag with the significance', async () => {
    // promoteTurnIfSignificant.test.ts feeds `tail_only` rows directly; this
    // pins the column that produces them, or the guard reads `undefined`.
    const { pool, queries } = recordingPool();
    await promoteTurnIfSignificant({
      pool,
      tenantId: 't1',
      kg,
      turnId: 'turn:s:2026-09-22T08:01:00.000Z',
      userId: 'user-1',
      threshold: 0.4,
      fallbackAssistantAnswer: 'ok',
      log: () => {},
    });
    assert.ok(
      /COALESCE\(\(properties->>'tailOnly'\)::boolean, FALSE\) AS tail_only/.test(
        code(queries[0]?.sql ?? ''),
      ),
      'significance lookup must project tail_only',
    );
  });
});
