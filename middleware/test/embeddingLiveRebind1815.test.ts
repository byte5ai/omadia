import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { EmbeddingClient, EmbeddingProvider } from '@omadia/plugin-api';
import type { Pool, PoolClient, QueryResult } from 'pg';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { startGateRunner } from '@omadia/knowledge-graph-neon/dist/gateReevaluation.js';
import { KnowledgeGraphTool } from '@omadia/orchestrator';

import { activate } from '../packages/harness-orchestrator-extras/src/plugin.js';
import type { MemoryFeatureStatus } from '../packages/harness-orchestrator-extras/src/memoryFeatureStatus.js';
import { createRecallRelevanceJudge } from '../packages/harness-orchestrator-extras/src/recallRelevanceJudge.js';
import { TopicDetector } from '../packages/harness-orchestrator-extras/src/topicDetector.js';
import {
  ModelServiceWithdrawnError,
} from '../src/platform/modelGatewayServices.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

import { fakePluginContext } from './_helpers/fakePluginContext.js';

/**
 * ADR-0194 — embedding and model consumers follow provider changes live.
 *
 *  - #1815: orchestrator-extras resolves `embeddingClient@1` per call, so a
 *    provider that appears, changes or goes away after `activate()` is seen
 *    by the topic detector and by the memory-feature status without a restart.
 *  - #1855: the recall relevance judge resolves `class:fast` per call.
 *  - #1817: the knowledge-graph gate withdraws its approved client the moment
 *    the registry stops publishing it, and the kernel makes a withdrawn model
 *    service refuse every later call.
 */

function vectorClient(vector: number[], calls: string[] = []): EmbeddingClient {
  return {
    embed: async (text: string): Promise<number[]> => {
      calls.push(text);
      return vector;
    },
  };
}

function llmReplying(text: string, requests: LlmRequest[] = []): LlmProvider {
  return {
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      requests.push(req);
      return { content: [{ type: 'text', text }] } as unknown as LlmResponse;
    },
  } as unknown as LlmProvider;
}

describe('#1815 — the topic detector embeds through the provider active at call time', () => {
  const history = [{ userMessage: 'Odoo invoices', assistantAnswer: 'ok' }] as never;

  it('answers continue-default without a provider, and embeds once one is published', async () => {
    let current: EmbeddingClient | undefined;
    const calls: string[] = [];
    const detector = new TopicDetector(() => current, llmReplying('continue'));

    const before = await detector.classify({ userMessage: 'next question', history });
    assert.deepEqual(before, { decision: 'continue', reason: 'no-embedding-provider' });
    assert.equal(calls.length, 0);

    current = vectorClient([1, 0], calls);
    const after = await detector.classify({ userMessage: 'next question', history });
    assert.equal(after.reason, 'similarity-high');
    assert.ok(calls.includes('next question'), 'the newly published client must be used');
  });
});

describe('#1815 — orchestrator-extras activate() follows the embedding provider live', () => {
  it('reports topic detection on as soon as a provider is published, without reactivating', async () => {
    const fake = fakePluginContext({
      services: {
        knowledgeGraph: {},
        installedPluginConfigReader: () => undefined,
        llmProviderPool: {
          get: async (id: string) => ({ id, complete: async () => ({ content: [] }) }),
          usable: async () => true,
          invalidate: () => undefined,
          invalidateAll: () => undefined,
          cachedIds: () => ['anthropic'],
        },
      },
    });
    const handle = await activate(fake.ctx);
    try {
      const status = fake.provided.get('memoryFeatureStatus') as MemoryFeatureStatus;
      assert.ok(fake.provided.has('topicDetector'), 'published whenever an LLM is available');
      assert.equal(status.topicDetector, 'disabled');
      assert.equal(status.reasons?.topicDetector, 'no_embedding_provider');

      // The provider activates after this plugin (Reactivate provider).
      const disposeClient = fake.ctx.services.provide('embeddingClient', vectorClient([1]));
      assert.equal(status.topicDetector, 'active');
      assert.equal(status.reasons?.topicDetector, undefined);
      // The admin status route serialises the object per request.
      assert.equal(
        (JSON.parse(JSON.stringify(status)) as MemoryFeatureStatus).topicDetector,
        'active',
      );

      // ...and goes away again (uninstall).
      disposeClient();
      assert.equal(status.topicDetector, 'disabled');
      assert.equal(status.reasons?.topicDetector, 'no_embedding_provider');
    } finally {
      await handle.close();
    }
  });
});

describe('#1855 — the recall judge resolves its model per call', () => {
  it('sends the model the resolver names at call time', async () => {
    const requests: LlmRequest[] = [];
    let fast = 'seed-fast';
    const judge = createRecallRelevanceJudge({
      llm: llmReplying(JSON.stringify({ relevant: ['a'] }), requests),
      model: () => fast,
      verdictCacheMax: 0,
    });
    const candidates = [{ id: 'a', kind: 'insight' as const, text: 'fact' }];

    await judge.filterRelevant('question', candidates);
    fast = 'discovered-fast'; // live model discovery landed
    await judge.filterRelevant('question', candidates);

    assert.deepEqual(
      requests.map((r) => r.model),
      ['seed-fast', 'discovered-fast'],
    );
  });

  it('keys the verdict cache by the model in use, so a new model is asked again', async () => {
    const requests: LlmRequest[] = [];
    let fast = 'seed-fast';
    const judge = createRecallRelevanceJudge({
      llm: llmReplying(JSON.stringify({ relevant: ['a'] }), requests),
      model: () => fast,
    });
    const candidates = [{ id: 'a', kind: 'insight' as const, text: 'fact' }];
    await judge.filterRelevant('question', candidates);
    await judge.filterRelevant('question', candidates); // cached
    fast = 'discovered-fast';
    await judge.filterRelevant('question', candidates);
    assert.equal(requests.length, 2);
  });
});

// ---------------------------------------------------------------------------
// #1817 — the knowledge-graph gate and the kernel registry.

const rows = (r: ReadonlyArray<Record<string, unknown>>): QueryResult =>
  ({ command: '', rowCount: r.length, oid: 0, rows: [...r], fields: [] }) as unknown as QueryResult;

/** A registry that already records the provider's model, so the verdict is `match`. */
function matchingGatePool(): Pool {
  const query = async (text: string): Promise<QueryResult> => {
    if (/pg_try_advisory_lock/i.test(text)) return rows([{ locked: true }]);
    if (/FROM pg_attribute/i.test(text)) {
      return rows([
        { table_name: 'graph_nodes', column_name: 'embedding', declared_type: 'vector(768)', typmod: 768 },
      ]);
    }
    if (/FROM graph_embedding_model/i.test(text)) {
      return rows([
        { model_id: 'ollama:nomic-embed-text', dimensions: 768, clear_pending: false, age_ms: 86_400_000 },
      ]);
    }
    return rows([]);
  };
  return {
    query,
    connect: async (): Promise<PoolClient> =>
      ({ query, release: (): void => undefined }) as unknown as PoolClient,
  } as unknown as Pool;
}

const NOMIC: EmbeddingProvider = {
  modelId: 'ollama:nomic-embed-text',
  dimensions: 768,
  embed: async () => new Array<number>(768).fill(0.1),
};

describe('#1817 — the gate withdraws a client the registry no longer publishes', () => {
  it('turns writes off, fences the epoch and stands the sweep down on the next read', async () => {
    let published: EmbeddingClient | undefined = NOMIC;
    const syncs: Array<{ client: EmbeddingClient | undefined; vectorWritesAllowed: boolean }> = [];
    const runner = await startGateRunner({
      pool: matchingGatePool(),
      tenantId: 't1',
      resolveRegistryClient: () => published,
      autoMigrateVectorColumns: true,
      syncBackfill: (args) => {
        syncs.push({ client: args.client, vectorWritesAllowed: args.vectorWritesAllowed });
      },
      log: () => undefined,
    });
    assert.equal(runner.vectorWritesAllowed(), true);
    assert.equal(runner.approvedClient(), NOMIC);
    const epochBefore = runner.epoch();

    published = undefined; // the provider was uninstalled

    // The sweep's fence reads the epoch first — that alone must withdraw.
    assert.ok(runner.epoch() > epochBefore, 'a withdrawal moves the epoch');
    assert.equal(runner.approvedClient(), undefined);
    assert.equal(runner.vectorWritesAllowed(), false);
    assert.equal(syncs[0]?.client, undefined, 'the backfill is stood down');
    assert.equal(runner.status.vectorWritesAllowed, false, '/health sees the same answer');
  });

  it('re-evaluates and approves a newly published client only with its own verdict', async () => {
    let published: EmbeddingClient | undefined = NOMIC;
    const runner = await startGateRunner({
      pool: matchingGatePool(),
      tenantId: 't1',
      resolveRegistryClient: () => published,
      autoMigrateVectorColumns: true,
      syncBackfill: () => undefined,
      log: () => undefined,
    });
    const reactivated: EmbeddingProvider = { ...NOMIC, embed: NOMIC.embed };
    published = reactivated; // reactivated: same model, new object

    assert.equal(runner.approvedClient(), undefined, 'the old object is withdrawn at once');
    // The scheduled re-evaluation runs on the chain; a later one resolves after it.
    await runner.reevaluate();
    assert.equal(runner.approvedClient(), reactivated);
    assert.equal(runner.vectorWritesAllowed(), true);
  });
});

describe('#1817 — a disposed model service refuses calls through a held reference', () => {
  it('rejects embed() once the provider disposed its registration', async () => {
    const registry = new ServiceRegistry();
    const calls: string[] = [];
    const dispose = registry.provide('embeddingClient', vectorClient([1], calls), '@omadia/embedding-adapter-openai');
    const held = registry.get<EmbeddingClient>('embeddingClient');
    assert.ok(held);
    await held.embed('before');

    dispose();

    await assert.rejects(held.embed('after'), ModelServiceWithdrawnError);
    assert.deepEqual(calls, ['before'], 'the removed adapter never sees the second call');
  });

  it('leaves a freshly published provider usable', async () => {
    const registry = new ServiceRegistry();
    const raw = vectorClient([1]);
    registry.provide('embeddingClient', raw, 'p')();
    registry.provide('embeddingClient', raw, 'p');
    const fresh = registry.get<EmbeddingClient>('embeddingClient');
    assert.deepEqual(await fresh?.embed('x'), [1]);
  });
});

describe('#1815 — the orchestrator resolves the embedding client per call', () => {
  async function graphWithTurn(): Promise<InMemoryKnowledgeGraph> {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 'talk-a',
      time: '2026-11-26T09:00:00.000Z',
      userMessage: 'Wer ist Anna?',
      assistantAnswer: 'Eine Mitarbeiterin.',
      entityRefs: [],
    });
    return g;
  }

  it('search_turns_semantic follows reactivate/switch and reports "not configured" after uninstall', async () => {
    const registry = new ServiceRegistry();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const disposeA = registry.provide('embeddingClient', vectorClient([1, 0], callsA), 'provider-a');
    const tool = new KnowledgeGraphTool(await graphWithTurn(), () =>
      registry.get<EmbeddingClient>('embeddingClient'),
    );

    await tool.handle({ query: 'search_turns_semantic', text: 'first' });
    assert.deepEqual(callsA, ['first']);

    // Switch: A withdrawn, B published. A held boot reference would now be
    // refused by the kernel; the resolver reaches B.
    disposeA();
    const disposeB = registry.provide('embeddingClient', vectorClient([0, 1], callsB), 'provider-b');
    const afterSwitch = await tool.handle({ query: 'search_turns_semantic', text: 'second' });
    assert.doesNotMatch(afterSwitch, /withdrawn|embedding failed/);
    assert.deepEqual(callsA, ['first'], 'the withdrawn provider sees nothing more');
    assert.deepEqual(callsB, ['second']);

    // Uninstall: no provider → the plain "not configured" answer, no throw.
    disposeB();
    const afterUninstall = await tool.handle({ query: 'search_turns_semantic', text: 'third' });
    assert.match(afterUninstall, /embeddings not configured/);
    assert.deepEqual(callsB, ['second']);
  });
});

describe('#1817 — a disposed replace() registration refuses calls through a held reference', () => {
  it('withdraws the replacement and leaves the restored provider usable', async () => {
    const registry = new ServiceRegistry();
    const baseCalls: string[] = [];
    const wrapCalls: string[] = [];
    registry.provide('embeddingClient', vectorClient([1], baseCalls), 'base');
    const restore = registry.replace('embeddingClient', vectorClient([2], wrapCalls), 'wrapper');
    const heldWrapper = registry.get<EmbeddingClient>('embeddingClient');
    assert.deepEqual(await heldWrapper?.embed('a'), [2]);

    restore();

    await assert.rejects(heldWrapper!.embed('b'), ModelServiceWithdrawnError);
    assert.deepEqual(wrapCalls, ['a']);
    const restored = registry.get<EmbeddingClient>('embeddingClient');
    assert.deepEqual(await restored?.embed('c'), [1], 'the previous provider stays live');
    assert.deepEqual(baseCalls, ['c']);
  });

  it('does not withdraw a previous provider handed back in to replace()', async () => {
    const registry = new ServiceRegistry();
    registry.provide('embeddingClient', vectorClient([1]), 'base');
    const current = registry.get<EmbeddingClient>('embeddingClient')!;
    const restore = registry.replace('embeddingClient', current, 'noop-wrapper');
    restore();
    assert.deepEqual(await current.embed('x'), [1]);
  });
});
