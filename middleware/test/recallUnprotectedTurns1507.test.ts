/**
 * #1507 — turns answered without Privacy Shield protection (no provider, or a
 * tool bypassed the shield) are stored `unprotected`. A recall that runs under
 * a shield passes `excludeUnprotected`, and the cross-session turn legs
 * (full-text, embedding, entity) return none of them: their answers hold real
 * names, and on the way back in only detector-visible spans (e-mails) would be
 * masked. Without the option, recall is unchanged, so an instance that never
 * runs a shield keeps its memory.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';
import { createPrivacyTurnHandle, turnContext } from '@omadia/orchestrator';
import type { SearchTurnsOptions } from '@omadia/plugin-api';
import { boundTurnSearch } from '../src/platform/pluginContext.js';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import { createSessionBriefingService } from '@omadia/orchestrator-extras/dist/index.js';
import { SESSION_SUMMARY_MARKER } from '@omadia/orchestrator-extras/dist/sessionSummaryGenerator.js';
import type { PrivacyGuardService, TurnIngest } from '@omadia/plugin-api';

function turn(
  scope: string,
  minute: number,
  answer: string,
  extra: Partial<TurnIngest> = {},
): TurnIngest {
  return {
    scope,
    time: `2026-10-28T08:${String(minute).padStart(2, '0')}:00.000Z`,
    userMessage: 'Wer arbeitet in Research & Development?',
    assistantAnswer: answer,
    entityRefs: [
      {
        system: 'odoo',
        model: 'hr.department',
        id: '7',
        op: 'read',
        displayName: 'Research Development',
      },
    ],
    ...extra,
  };
}

async function seeded(): Promise<InMemoryKnowledgeGraph> {
  const kg = new InMemoryKnowledgeGraph();
  await kg.ingestTurn(turn('s-open', 1, 'Marc Demo und Anita Oliver', { unprotected: true }));
  await kg.ingestTurn(turn('s-guarded', 2, 'Zwei Personen (maskiert)', { unprotected: false }));
  return kg;
}

describe('#1507 in-memory recall and unprotected turns', () => {
  it('full-text recall under a shield skips unprotected turns', async () => {
    const kg = await seeded();
    const all = await kg.searchTurns({ query: 'Research', excludeScope: 's-now' });
    assert.equal(all.length, 2, 'without the option recall is unchanged');
    const guarded = await kg.searchTurns({
      query: 'Research',
      excludeScope: 's-now',
      excludeUnprotected: true,
    });
    assert.deepEqual(
      guarded.map((h) => h.scope),
      ['s-guarded'],
    );
  });

  it('hybrid recall under a shield skips unprotected turns', async () => {
    const kg = await seeded();
    const hits = await kg.searchTurnsByEmbedding({
      queryEmbedding: [0.1, 0.2, 0.3],
      ftsQuery: 'Research',
      excludeScope: 's-now',
      excludeUnprotected: true,
    });
    assert.ok(hits.every((h) => h.scope !== 's-open'));
  });

  it('entity recall under a shield skips unprotected turns', async () => {
    const kg = await seeded();
    const hits = await kg.findEntityCapturedTurns({
      terms: ['research'],
      excludeScope: 's-now',
      excludeUnprotected: true,
    });
    const scopes = hits.flatMap((h) => h.turns.map((t) => t.scope));
    assert.ok(!scopes.includes('s-open'), JSON.stringify(scopes));
  });

  it('a re-ingest without the flag keeps it; an explicit false clears it', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const search = () =>
      kg.searchTurns({ query: 'Research', excludeScope: 's-now', excludeUnprotected: true });
    await kg.ingestTurn(turn('s-open', 1, 'Marc Demo', { unprotected: true }));
    // A backfill from the session transcript carries no flag.
    await kg.ingestTurn(turn('s-open', 1, 'Marc Demo'));
    assert.equal((await search()).length, 0, 'flag survives a flagless re-ingest');
    await kg.ingestTurn(turn('s-open', 1, 'Marc Demo', { unprotected: false }));
    assert.equal((await search()).length, 1, 'a live re-ingest can clear it');
  });

  it('keeps unprotected turns in the session tail', async () => {
    const kg = await seeded();
    const session = await kg.getSession('s-open');
    assert.equal(session?.turns.length, 1);
    assert.equal(session?.turns[0]?.turn.props['unprotected'], true);
  });
});

// --- Neon: the predicate lives in SQL a fake pool never evaluates -----------

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function recordingPool(
  respond: (sql: string) => ReadonlyArray<Record<string, unknown>> | undefined = () => undefined,
): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const query = async (sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> => {
    queries.push({ sql, params: params ?? [] });
    const rows = [...(respond(sql) ?? [])];
    return { command: '', rowCount: rows.length, oid: 0, rows, fields: [] } as unknown as QueryResult;
  };
  const pool = {
    query,
    async connect(): Promise<PoolClient> {
      return { query, release: (): void => {} } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, queries };
}

const code = (sql: string): string => sql.replace(/--.*$/gm, '');
const FILTER =
  /NOT \$(\d+)::boolean OR COALESCE\(\((?:t\.)?properties->>'unprotected'\)::boolean, FALSE\) = FALSE/;

/** The query carries the predicate and binds `true` to its parameter. */
function assertFilters(q: CapturedQuery | undefined, what: string, expected: boolean): void {
  assert.ok(q, `${what}: query was issued`);
  const m = FILTER.exec(code(q.sql));
  assert.ok(m, `${what}: must carry the unprotected predicate`);
  assert.equal(q.params[Number(m[1]) - 1], expected, `${what}: parameter`);
}

const turnSelects = (qs: ReadonlyArray<CapturedQuery>): CapturedQuery[] =>
  qs.filter((q) => /type = 'Turn'/.test(q.sql));

describe('#1507 Neon recall queries honour excludeUnprotected', () => {
  for (const flag of [true, false]) {
    it(`searchTurns (excludeUnprotected=${String(flag)})`, async () => {
      const { pool, queries } = recordingPool();
      const kg = new NeonKnowledgeGraph({ pool, tenantId: 't1' });
      await kg.searchTurns({ query: 'blau', excludeUnprotected: flag });
      assertFilters(turnSelects(queries)[0], 'searchTurns', flag);
    });
  }

  it('searchTurnsByEmbedding', async () => {
    const { pool, queries } = recordingPool();
    const kg = new NeonKnowledgeGraph({ pool, tenantId: 't1' });
    await kg.searchTurnsByEmbedding({
      queryEmbedding: [0.1, 0.2, 0.3],
      ftsQuery: 'blau',
      excludeUnprotected: true,
    });
    assertFilters(turnSelects(queries)[0], 'searchTurnsByEmbedding', true);
  });

  it('findEntityCapturedTurns', async () => {
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
    await kg.findEntityCapturedTurns({ terms: ['lilium'], excludeUnprotected: true });
    assertFilters(turnSelects(queries)[0], 'findEntityCapturedTurns', true);
  });

  it('ingest writes the flag only when set', async () => {
    const run = async (extra: Partial<TurnIngest>): Promise<string> => {
      const { pool, queries } = recordingPool((sql) =>
        /INSERT INTO graph_nodes/.test(sql) ? [{ id: 'uuid-node' }] : undefined,
      );
      const kg = new NeonKnowledgeGraph({ pool, tenantId: 't1' });
      await kg.ingestTurn(turn('s-x', 1, 'a', extra));
      return JSON.stringify(queries.map((q) => q.params));
    };
    assert.match(await run({ unprotected: true }), /unprotected\\?":true/);
    assert.match(await run({ unprotected: false }), /unprotected\\?":false/);
    assert.doesNotMatch(await run({}), /unprotected/);
  });
});

describe('#1507 privacy handle reports a bypass', () => {
  function handle(bypassTool: string | undefined) {
    return createPrivacyTurnHandle({
      service: {
        recordBypassedTool: async () => undefined,
      } as unknown as PrivacyGuardService,
      sessionId: 's',
      turnId: 't',
      resolveBypass: (name) =>
        name === bypassTool ? { pluginId: '@omadia/agent-confluence' } : undefined,
    });
  }

  it('is false until a tool bypasses, then true', () => {
    const h = handle('confluence_get_page');
    assert.equal(h.hasBypassed?.(), false);
    h.checkBypass('query_odoo_hr');
    assert.equal(h.hasBypassed?.(), false);
    h.checkBypass('confluence_get_page');
    assert.equal(h.hasBypassed?.(), true);
  });

  it('is true after a recorded bypass', async () => {
    const h = handle(undefined);
    await h.recordBypassedTool({
      toolName: 'x',
      pluginId: 'p',
      reason: 'operator_setting',
      bytes: 1,
    });
    assert.equal(h.hasBypassed?.(), true);
  });
});

describe('#1507 context retriever forwards the flag', () => {
  it('drops unprotected turns from the related-turns legs, keeps the tail', async () => {
    const kg = await seeded();
    // The current chat is s-open itself: its own unprotected turn stays in
    // the tail, while s-guarded and other chats are recalled cross-session.
    await kg.ingestTurn(
      turn('s-other-open', 3, 'Marc Demo leitet Research', { unprotected: true }),
    );
    const retr = new ContextRetriever(kg);
    const guarded = await retr.assembleForBudget({
      userMessage: 'Wer arbeitet in Research Development?',
      sessionScope: 's-open',
      excludeUnprotected: true,
    });
    assert.ok(!guarded.text.includes('leitet Research'), guarded.text);
    assert.ok(guarded.text.includes('Marc Demo und Anita Oliver'), 'own tail kept');

    const open = await retr.assembleForBudget({
      userMessage: 'Wer arbeitet in Research Development?',
      sessionScope: 's-open',
    });
    assert.ok(open.text.includes('leitet Research'), 'unchanged without a shield');
  });
});

describe('#1507 session-briefing summaries inherit the flag', () => {
  async function summaryOf(unprotected: boolean): Promise<unknown> {
    const kg = new InMemoryKnowledgeGraph();
    // Old enough for briefing mode (resume window is minutes).
    await kg.ingestTurn({
      scope: 's-b',
      time: '2024-01-01T08:00:00.000Z',
      userMessage: 'Wer ist in R&D?',
      assistantAnswer: 'Marc Demo',
      entityRefs: [],
      unprotected,
    });
    const svc = createSessionBriefingService({
      kg,
      summaryGenerator: { generate: async () => 'Marc Demo leitet R&D.' },
      log: () => {},
    });
    await svc.loadSessionBriefing({ scope: 's-b', agentId: 'a' });
    const session = await kg.getSession('s-b');
    const summary = session?.turns.find(
      (t) => t.turn.props['userMessage'] === SESSION_SUMMARY_MARKER,
    );
    assert.ok(summary, 'summary turn persisted');
    return summary.turn.props['unprotected'];
  }

  it('flags a summary of an unprotected turn, so cross-session recall skips it', async () => {
    assert.equal(await summaryOf(true), true);
  });

  it('leaves a summary of protected turns unflagged', async () => {
    assert.equal(await summaryOf(false), false);
  });
});

describe('#1507 a plugin turn search follows the turn shield', () => {
  const inTurn = <T>(shielded: boolean, fn: () => T): Promise<T> =>
    turnContext.run(
      {
        turnId: 't',
        turnDate: '2026-10-28',
        ...(shielded
          ? {
              privacyHandle: createPrivacyTurnHandle({
                service: {} as unknown as PrivacyGuardService,
                sessionId: 's',
                turnId: 't',
              }),
            }
          : {}),
      },
      async () => fn(),
    );

  it('adds excludeUnprotected only under a shield', async () => {
    const shielded = await inTurn(true, () =>
      boundTurnSearch<SearchTurnsOptions>({ query: 'x' }),
    );
    assert.equal(shielded?.options.excludeUnprotected, true);
    const open = await inTurn(false, () =>
      boundTurnSearch<SearchTurnsOptions>({ query: 'x' }),
    );
    assert.equal(open?.options.excludeUnprotected, undefined);
  });
});
