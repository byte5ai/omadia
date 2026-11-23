/**
 * #1536 — content derived from an unprotected turn stays out of recall under
 * a Privacy Shield. #1507 flagged the turns themselves; their curated
 * memories (with excerpts), memories stamped `unprotected` at write time (a
 * bypassed MCP result, a rule written in an unprotected turn) and their plans
 * came back regardless, and recall masking only catches detector-visible
 * spans. The recall contract (`recallDerivedUnprotected1536Contract.ts`) runs
 * here against the in-memory graph and in `recallDerivedUnprotected1536.pg.test.ts`
 * against the Neon backend.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

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
import type {
  KnowledgeGraph,
  MemorableKnowledgeIngest,
  PrivacyGuardService,
} from '@omadia/plugin-api';

import { runContract, seed, VECTOR, VIEWER } from './recallDerivedUnprotected1536Contract.js';

runContract('InMemoryKnowledgeGraph', async () => {
  const kg = new InMemoryKnowledgeGraph();
  return seed(kg, async (id) => {
    kg.setEmbedding(id, VECTOR);
  });
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

function recordingKg(): {
  kg: KnowledgeGraph;
  created: MemorableKnowledgeIngest[];
  first: Promise<void>;
} {
  const created: MemorableKnowledgeIngest[] = [];
  let resolveFirst: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const kg = {
    createMemorableKnowledge: async (input: MemorableKnowledgeIngest) => {
      created.push(input);
      resolveFirst();
      return { memorableKnowledgeNodeId: 'mk:1', skippedInvolved: 0, skippedRequired: 0, skippedDerivedFrom: 0 };
    },
  } as unknown as KnowledgeGraph;
  return { kg, created, first };
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
  async function promote(
    privacyHandle: ReturnType<typeof guardHandle> | undefined,
    inTurn = true,
  ): Promise<MemorableKnowledgeIngest> {
    const { kg, created, first } = recordingKg();
    const store = new DurableRulesMemoryStore(new InMemoryMemoryStore(), {
      pool: noRowsPool,
      kg,
      tenantId: 't',
    });
    const write = () =>
      store.writeFile('/memories/_rules/kontakt.md', 'Ansprechpartner Lilium: Marc Demo');
    if (inTurn) {
      await srcTurnContext.run(
        { turnId: 't', ...(privacyHandle ? { privacyHandle } : {}) } as never,
        write,
      );
    } else {
      await write();
    }
    // The promotion is fire-and-forget; wait for its one graph write.
    await first;
    assert.equal(created.length, 1);
    return created[0]!;
  }

  it('no turn context at all: stamped (fail closed)', async () => {
    assert.equal((await promote(undefined, false)).unprotected, true);
  });

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
