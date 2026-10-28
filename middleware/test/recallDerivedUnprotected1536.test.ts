/**
 * #1536 — content derived from an unprotected turn stays out of recall under
 * a Privacy Shield. #1507 flagged the turns themselves; their curated
 * memories (with excerpts), memories stamped `unprotected` at write time (a
 * bypassed MCP result, a rule written in an unprotected turn) and their plans
 * came back regardless, and recall masking only catches detector-visible
 * spans. Runs against the in-memory graph and, when `GRAPH_PG_TEST_URL`
 * points at a pgvector Postgres, against the Neon backend.
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore } from '@omadia/memory';
import {
  createPrivacyTurnHandle,
  SessionLogger,
  TranscribeRecordingTool,
  turnContext,
} from '@omadia/orchestrator';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import { DurableRulesMemoryStore } from '../packages/harness-orchestrator/src/durableRulesMemoryStore.js';
// The decorator above is imported from source, so its turn context is too.
import { turnContext as srcTurnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type {
  KnowledgeGraph,
  MemorableKnowledgeIngest,
  PrivacyGuardService,
  TurnIngest,
} from '@omadia/plugin-api';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'recall-derived-1536';
const VIEWER = '15361536-0000-4000-8000-000000001536';
const VECTOR = Array.from({ length: 768 }, (_, i) => (i % 7) / 7 + 0.01);

function turn(scope: string, minute: number, unprotected: boolean | undefined): TurnIngest {
  return {
    scope,
    time: `2026-10-28T09:${String(minute).padStart(2, '0')}:00.000Z`,
    userMessage: 'Wer leitet das Projekt Lilium?',
    assistantAnswer: 'Marc Demo leitet es.',
    entityRefs: [],
    ...(unprotected !== undefined ? { unprotected } : {}),
  };
}

interface Seeded {
  readonly kg: KnowledgeGraph;
  readonly mk: { readonly fromOpen: string; readonly fromGuarded: string; readonly stamped: string };
}

type Embed = (externalId: string) => Promise<void>;

async function seed(kg: KnowledgeGraph, embed: Embed): Promise<Seeded> {
  const open = await kg.ingestTurn(turn('s-open', 1, true));
  const guarded = await kg.ingestTurn(turn('s-guarded', 2, false));
  const legacy = await kg.ingestTurn(turn('s-legacy', 3, undefined));
  const memory = async (
    summary: string,
    extra: { derivedFromTurnIds?: string[]; unprotected?: boolean },
  ): Promise<string> => {
    const res = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary,
      createdBy: `web:${VIEWER}`,
      aclOwners: [VIEWER],
      palaiaExcerpts: { texts: [`${summary} (Auszug)`], source: 'llm' },
      ...extra,
    });
    await embed(res.memorableKnowledgeNodeId);
    for (const ex of await kg.listExcerptsForMemory(res.memorableKnowledgeNodeId)) {
      await embed(ex.id);
    }
    return res.memorableKnowledgeNodeId;
  };
  const mk = {
    fromOpen: await memory('Marc Demo leitet Lilium', { derivedFromTurnIds: [open.turnId] }),
    fromGuarded: await memory('Lilium hat eine Leitung', { derivedFromTurnIds: [guarded.turnId] }),
    stamped: await memory('MCP crm · get_contact: Anita Oliver', { unprotected: true }),
  };
  // Plans: one per turn kind, one never linked to a turn (provenance unknown).
  const plan = async (id: string, turnExternalId?: string): Promise<void> => {
    await kg.ingestPlan({
      planId: id,
      scope: `scope-${id}`,
      ...(turnExternalId ? { turnExternalId } : {}),
      strategy: `Lilium ${id}`,
      createdAt: `2026-10-28T09:0${id.length}:00.000Z`,
    });
  };
  await plan('p-open', open.turnId);
  await plan('p-guarded', guarded.turnId);
  await plan('p-legacy', legacy.turnId);
  await plan('p-orphan');
  return { kg, mk };
}

function runContract(label: string, setup: () => Promise<Seeded | undefined>): void {
  describe(`#1536 derived recall · ${label}`, () => {
    it('memory search under a shield skips MK derived from or stamped unprotected', async (t) => {
      const s = await setup();
      if (!s) return t.skip('no test database');
      const search = (excludeUnprotected: boolean) =>
        s.kg.searchMemorableKnowledgeByEmbedding({
          queryEmbedding: VECTOR,
          viewerOmadiaUserId: VIEWER,
          minSimilarity: 0,
          limit: 10,
          excludeUnprotected,
        });
      assert.equal((await search(false)).length, 3, 'without the option recall is unchanged');
      assert.deepEqual(
        (await search(true)).map((h) => h.mk.id),
        [s.mk.fromGuarded],
      );
    });

    it('excerpt search follows its parent MK', async (t) => {
      const s = await setup();
      if (!s) return t.skip('no test database');
      const search = (excludeUnprotected: boolean) =>
        s.kg.searchExcerptsByEmbedding({
          queryEmbedding: VECTOR,
          viewerOmadiaUserId: VIEWER,
          minSimilarity: 0,
          limit: 10,
          excludeUnprotected,
        });
      assert.equal((await search(false)).length, 3);
      assert.deepEqual(
        (await search(true)).map((h) => h.parentMkId),
        [s.mk.fromGuarded],
      );
    });

    it('plan recall under a shield keeps only plans of a known, protected turn', async (t) => {
      const s = await setup();
      if (!s) return t.skip('no test database');
      const ids = async (excludeUnprotected: boolean): Promise<string[]> =>
        (await s.kg.listRecentPlans({ limit: 10, excludeUnprotected }))
          .map((p) => String(p.props['planId']))
          .sort();
      assert.deepEqual(await ids(false), ['p-guarded', 'p-legacy', 'p-open', 'p-orphan']);
      // A turn stored before the flag existed counts as protected, as in the
      // turn legs; a plan with no turn has unknown provenance and is dropped.
      assert.deepEqual(await ids(true), ['p-guarded', 'p-legacy']);
    });
  });
}

runContract('InMemoryKnowledgeGraph', async () => {
  const kg = new InMemoryKnowledgeGraph();
  return seed(kg, async (id) => {
    kg.setEmbedding(id, VECTOR);
  });
});

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'recallDerivedUnprotected1536',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;
let seeded: Promise<Seeded> | undefined;

async function clean(p: Pool): Promise<void> {
  await p.query('DELETE FROM graph_edges WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
}

runContract('NeonKnowledgeGraph (real PG)', async () => {
  if (!pool) return undefined;
  seeded ??= (async () => {
    await runGraphMigrations(pool);
    await clean(pool);
    const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
    return seed(kg, async (id) => {
      await pool.query(
        'UPDATE graph_nodes SET embedding = $1::vector WHERE tenant_id = $2 AND external_id = $3',
        [`[${VECTOR.join(',')}]`, TENANT, id],
      );
    });
  })();
  return seeded;
});

after(async () => {
  if (!pool) return;
  await clean(pool);
  await pool.end();
});

// --- The retriever and the writers ------------------------------------------

describe('#1536 context retriever forwards the flag to every derived leg', () => {
  it('plan, memory, excerpt and durable legs get excludeUnprotected under a shield', async () => {
    const seen = new Map<string, unknown[]>();
    const inner = new InMemoryKnowledgeGraph();
    const spied = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (
          typeof value === 'function' &&
          ['listRecentPlans', 'searchMemorableKnowledgeByEmbedding', 'searchExcerptsByEmbedding'].includes(
            String(prop),
          )
        ) {
          return (opts: { excludeUnprotected?: boolean }) => {
            const list = seen.get(String(prop)) ?? [];
            list.push(opts.excludeUnprotected);
            seen.set(String(prop), list);
            return (value as (o: unknown) => unknown).call(target, opts);
          };
        }
        return value;
      },
    });
    const retr = new ContextRetriever(spied, {}, { embed: async () => VECTOR } as never);
    for (const excludeUnprotected of [true, false]) {
      seen.clear();
      await retr.assembleForBudget({
        userMessage: 'Wie steht das Projekt Lilium?',
        agentId: 'agent-test',
        sessionScope: 's-now',
        userId: VIEWER,
        ...(excludeUnprotected ? { excludeUnprotected } : {}),
      });
      const expected = excludeUnprotected ? true : undefined;
      assert.deepEqual(seen.get('listRecentPlans'), [expected], 'plan leg');
      // Fuzzy memory leg and durable leg.
      assert.deepEqual(seen.get('searchMemorableKnowledgeByEmbedding'), [expected, expected]);
      assert.deepEqual(seen.get('searchExcerptsByEmbedding'), [expected]);
    }
  });
});

function recordingKg(): { kg: KnowledgeGraph; created: MemorableKnowledgeIngest[] } {
  const created: MemorableKnowledgeIngest[] = [];
  const kg = {
    createMemorableKnowledge: async (input: MemorableKnowledgeIngest) => {
      created.push(input);
      return { memorableKnowledgeNodeId: 'mk:1', skippedInvolved: 0, skippedRequired: 0, skippedDerivedFrom: 0 };
    },
  } as unknown as KnowledgeGraph;
  return { kg, created };
}

const noRowsPool = { query: async () => ({ rows: [] }) } as unknown as Pool;

function guardHandle(bypassed: boolean) {
  const handle = createPrivacyTurnHandle({
    service: { recordBypassedTool: async () => undefined } as unknown as PrivacyGuardService,
    sessionId: 's',
    turnId: 't',
    resolveBypass: (tool: string) => (bypassed && tool === 'raw_tool' ? { pluginId: 'p' } : undefined),
  } as never);
  handle.checkBypass('raw_tool');
  return handle;
}

describe('#1536 durable rules written in an unprotected turn are stamped', () => {
  async function promote(privacyHandle: ReturnType<typeof guardHandle> | undefined): Promise<MemorableKnowledgeIngest> {
    const { kg, created } = recordingKg();
    const store = new DurableRulesMemoryStore(new InMemoryMemoryStore(), {
      pool: noRowsPool,
      kg,
      tenantId: 't',
    });
    await srcTurnContext.run(
      { turnId: 't', ...(privacyHandle ? { privacyHandle } : {}) } as never,
      () => store.writeFile('/memories/_rules/kontakt.md', 'Ansprechpartner Lilium: Marc Demo'),
    );
    for (let i = 0; i < 20 && created.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(created.length, 1);
    return created[0]!;
  }

  it('no shield: stamped', async () => {
    assert.equal((await promote(undefined)).unprotected, true);
  });
  it('a bypassed tool earlier in the turn: stamped', async () => {
    assert.equal((await promote(guardHandle(true))).unprotected, true);
  });
  it('a shielded turn: not stamped', async () => {
    assert.equal((await promote(guardHandle(false))).unprotected, undefined);
  });
});

describe('#1536 meeting transcripts are stored unprotected', () => {
  it('every transcript turn carries the flag', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const tool = new TranscribeRecordingTool({
      reader: {
        readByStorageKey: async () => ({ bytes: Buffer.from([1]), fileName: 'm.wav' }),
        readByUrl: async () => undefined,
      },
      getTranscription: () =>
        ({
          providerId: 'fake',
          transcribeFile: async () => ({
            text: 'Marc Demo: Lilium startet.',
            segments: [{ text: 'Lilium startet.', startMs: 0, endMs: 1, speaker: 'Marc Demo' }],
            language: 'de',
            durationMs: 1,
            provider: 'fake',
          }),
          transcribeStream: () => {
            throw new Error('unused');
          },
        }) as never,
      makeSessionLogger: (slug) => new SessionLogger(new InMemoryMemoryStore(), graph, undefined, slug),
    });
    await turnContext.run({ turnId: 't', sessionScope: 's-meet' } as never, () =>
      tool.handle({ storage_key: 'uploads/m.wav' }),
    );
    const session = await graph.getSession('s-meet');
    assert.ok(session && session.turns.length > 0);
    assert.ok(session.turns.every((t) => t.turn.props['unprotected'] === true));
    const recalled = await graph.searchTurns({ query: 'Lilium', excludeUnprotected: true });
    assert.equal(recalled.length, 0);
  });
});
