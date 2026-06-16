import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { promoteTurnIfSignificant } from '@omadia/orchestrator-extras/dist/promotion.js';
import type {
  KnowledgeGraph,
  MemorableKnowledgeIngest,
  MemorableKnowledgeIngestResult,
  PalaiaExcerpt,
} from '@omadia/plugin-api';

// Mock pg.Pool — captures executed SQL + returns scripted rows for
// each `query()` call. The promoter runs at most 3 SELECTs (significance
// lookup → idempotency lookup → createMemorableKnowledge via kg), so a
// queue covers the deterministic flow.
function makeFakePool(opts: {
  significanceRows?: ReadonlyArray<{ significance: number | null }>;
  idempotencyRows?: ReadonlyArray<{ external_id: string }>;
  throwOnQuery?: boolean;
}): {
  pool: { query: (sql: string, params: unknown[]) => Promise<unknown> };
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queue = [
    { rows: opts.significanceRows ?? [] },
    { rows: opts.idempotencyRows ?? [] },
  ];
  const pool = {
    async query(sql: string, params: unknown[]): Promise<unknown> {
      if (opts.throwOnQuery) throw new Error('db-down');
      calls.push({ sql, params });
      const next = queue.shift();
      return next ?? { rows: [] };
    },
  };
  return { pool, calls };
}

function makeFakeKg(opts: {
  resultId?: string;
  throwOnCreate?: boolean;
}): {
  kg: KnowledgeGraph;
  createCalls: MemorableKnowledgeIngest[];
} {
  const createCalls: MemorableKnowledgeIngest[] = [];
  const kg = {
    async createMemorableKnowledge(
      input: MemorableKnowledgeIngest,
    ): Promise<MemorableKnowledgeIngestResult> {
      if (opts.throwOnCreate) throw new Error('kg-create-failed');
      createCalls.push(input);
      return {
        memorableKnowledgeNodeId: opts.resultId ?? 'mk:uuid-1',
        skippedInvolved: 0,
        skippedRequired: 0,
        skippedDerivedFrom: 0,
      };
    },
  } as unknown as KnowledgeGraph;
  return { kg, createCalls };
}

const TURN_ID = 'turn:smoke:2026-05-14T00:00:00.000Z';
const USER_ID = '12345678-1234-1234-1234-123456789abc';
const FALLBACK_ANSWER =
  'pgvector mit Dim 768 nach Migration 0007 deployed.';

describe('Slice 4b · promoteTurnIfSignificant', () => {
  it('promotes when significance >= threshold (palaiaExcerpt path)', async () => {
    const { pool, calls } = makeFakePool({
      significanceRows: [{ significance: 0.85 }],
      idempotencyRows: [],
    });
    const { kg, createCalls } = makeFakeKg({ resultId: 'mk:abc' });
    const excerpt: PalaiaExcerpt = {
      suggestedKind: 'decision',
      suggestedSummary: 'Migration 0007 ist live.',
      suggestedRationale: 'Pgvector + voyage-3-lite.',
      excerpts: [],
      source: 'llm',
    };
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      palaiaExcerpt: excerpt,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, true);
    assert.equal(out.reason, 'promoted');
    assert.equal(out.mkId, 'mk:abc');
    assert.equal(out.significance, 0.85);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0]!.kind, 'decision');
    assert.equal(createCalls[0]!.summary, 'Migration 0007 ist live.');
    assert.equal(createCalls[0]!.rationale, 'Pgvector + voyage-3-lite.');
    assert.deepEqual(createCalls[0]!.aclOwners, [USER_ID]);
    assert.deepEqual(createCalls[0]!.involvedOmadiaUserIds, [USER_ID]);
    assert.deepEqual(createCalls[0]!.derivedFromTurnIds, [TURN_ID]);
    assert.equal(createCalls[0]!.createdBy, `auto:${USER_ID}`);
    assert.equal(calls.length, 2); // significance + idempotency
  });

  it('promotes with fallback summary when palaiaExcerpt absent', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.9 }],
    });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, true);
    assert.equal(createCalls[0]!.kind, 'insight');
    assert.match(createCalls[0]!.summary, /pgvector|Migration/);
  });

  it('skips when significance < threshold', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.4 }],
    });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'below-threshold');
    assert.equal(out.significance, 0.4);
    assert.equal(createCalls.length, 0);
  });

  it('boundary: significance == threshold promotes', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.7 }],
    });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, true);
    assert.equal(createCalls.length, 1);
  });

  it('skips when significance is null (scorer-off)', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: null }],
    });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'no-significance');
    assert.equal(createCalls.length, 0);
  });

  it('skips when Turn-Node is missing', async () => {
    const { pool } = makeFakePool({ significanceRows: [] });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'missing-turn');
    assert.equal(createCalls.length, 0);
  });

  it('skips when userId is empty', async () => {
    const { pool, calls } = makeFakePool({});
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: '',
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'missing-user');
    assert.equal(calls.length, 0); // doesn't even query DB
    assert.equal(createCalls.length, 0);
  });

  it('idempotency: returns already-promoted when MK exists', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.9 }],
      idempotencyRows: [{ external_id: 'mk:existing-1' }],
    });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'already-promoted');
    assert.equal(out.mkId, 'mk:existing-1');
    assert.equal(out.significance, 0.9);
    assert.equal(createCalls.length, 0);
  });

  it('does not throw on pool failure — returns error', async () => {
    const { pool } = makeFakePool({ throwOnQuery: true });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'error');
    assert.equal(createCalls.length, 0);
  });

  it('does not throw on createMemorableKnowledge failure', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.9 }],
    });
    const { kg } = makeFakeKg({ throwOnCreate: true });
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: FALLBACK_ANSWER,
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'error');
  });

  it('fallback summary capped at 500 chars', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.85 }],
    });
    const { kg, createCalls } = makeFakeKg({});
    const longAnswer = 'x'.repeat(800);
    await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: longAnswer,
      log: () => {},
    });
    assert.ok(createCalls[0]!.summary.length <= 500);
  });

  it('skips agent-narration turns (ingest hygiene) even above threshold', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.85 }],
      idempotencyRows: [],
    });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      // First-person agent narration — high significance but pure meta-process.
      fallbackAssistantAnswer:
        'Ich schaue kurz in den Memory für Konventionen und ob es schon Detail-Befunde gibt.',
      log: () => {},
    });
    assert.equal(out.promoted, false);
    assert.equal(out.reason, 'hygiene-skip');
    assert.equal(createCalls.length, 0, 'narration must NOT be stored as MK');
  });

  it('still stores short factual turns (length is not a gate for fuzzy)', async () => {
    const { pool } = makeFakePool({
      significanceRows: [{ significance: 0.85 }],
      idempotencyRows: [],
    });
    const { kg, createCalls } = makeFakeKg({});
    const out = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'byte5',
      kg,
      turnId: TURN_ID,
      userId: USER_ID,
      threshold: 0.7,
      fallbackAssistantAnswer: 'Preis 1200 EUR.',
      log: () => {},
    });
    assert.equal(out.promoted, true);
    assert.equal(createCalls.length, 1);
  });
});
