/**
 * The side doors past a restricted turn's graph boundary, closed.
 *
 * The recall legs and the in-process `query_knowledge_graph` honour a turn's
 * `enforce-strict` / `members` boundary. Three other ways to read the graph
 * did not:
 *
 *  - the kernel-native registration of `query_knowledge_graph`, which the
 *    subscription-CLI path dispatches through and which knows no turn;
 *  - a context-free turn of such an agent (web, API), which carries no
 *    isolation at all;
 *  - a plugin's `KnowledgeGraphAccessor` (`searchTurns`,
 *    `findEntityCapturedTurns`), which a domain tool may call mid-turn.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore } from '@omadia/memory';
import {
  MemoryBinder,
  NativeToolRegistry,
  Orchestrator,
  turnContext,
  type ContextMemoryMode,
  type GraphReadScope,
} from '@omadia/orchestrator';
import type { LlmProvider } from '@omadia/llm-provider';
import type { SearchTurnsOptions } from '@omadia/plugin-api';

import { boundTurnSearch } from '../src/platform/pluginContext.js';

const SECRET = 'Kranich Budget 4,2 Mio';

async function graphWithSecret(): Promise<InMemoryKnowledgeGraph> {
  const g = new InMemoryKnowledgeGraph();
  await g.ingestTurn({
    scope: 'agent-x::msteams-conv-kranich',
    time: '2026-10-06T09:00:00.000Z',
    userMessage: SECRET,
    assistantAnswer: 'ok',
    entityRefs: [],
    owners: ['u-a', 'u-b'],
  });
  return g;
}

function agent(graph: InMemoryKnowledgeGraph, mode: ContextMemoryMode): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  new Orchestrator({
    provider: {} as LlmProvider,
    model: 'test',
    maxTokens: 1,
    maxToolIterations: 1,
    domainTools: [],
    nativeToolRegistry: registry,
    agentId: 'agent-x',
    knowledgeGraph: graph,
    memoryBinder: new MemoryBinder({ agentSlug: 'agent-x', root: new InMemoryMemoryStore(), mode }),
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
  return registry;
}

const search = { query: 'search_turns', text: 'Kranich' };

describe('graph boundary — the registered (CLI-path) graph tool', () => {
  for (const mode of ['enforce-strict', 'members'] as const) {
    it(`sees nothing for an agent in ${mode}`, async () => {
      const handler = agent(await graphWithSecret(), mode).get('query_knowledge_graph')?.handler;
      assert.ok(handler, 'the graph tool is not registered');
      assert.doesNotMatch(await handler(search), /4,2 Mio/);
    });
  }

  it('CONTROL: stays unrestricted for an agent in enforce', async () => {
    const handler = agent(await graphWithSecret(), 'enforce').get('query_knowledge_graph')?.handler;
    assert.match(String(await handler?.(search)), /4,2 Mio/);
  });
});

describe('graph boundary — a plugin’s turn search inside a restricted turn', () => {
  const within = async <T>(value: GraphReadScope | undefined, fn: () => Promise<T>): Promise<T> =>
    turnContext.run(
      { turnId: 't', turnDate: '2026-10-06', graphReadScope: value ? { value } : {} },
      fn,
    );

  it('members: only turns everyone present owns, of this agent', async () => {
    const graph = await graphWithSecret();
    const run = (audience: string[]): Promise<number> =>
      within({ kind: 'members', audience, agentScopePrefix: 'agent-x::' }, async () => {
        const bounded = boundTurnSearch<SearchTurnsOptions>({ query: 'Kranich' });
        if (!bounded) return -1;
        return (await graph.searchTurns(bounded.options)).filter((h) => bounded.scopeAllowed(h.scope)).length;
      });
    assert.equal(await run(['u-a']), 1);
    assert.equal(await run(['u-a', 'u-newbie']), 0);
  });

  it('an unknown room, a context-free turn of such an agent, or no conversation: nothing', async () => {
    for (const value of [
      { kind: 'members', audience: null, agentScopePrefix: 'agent-x::' },
      { kind: 'nothing' },
      { kind: 'conversation', scope: null },
    ] as const) {
      assert.equal(await within(value, async () => Promise.resolve(boundTurnSearch<SearchTurnsOptions>({ query: 'x' }))), null);
    }
  });

  it('enforce-strict: the conversation, matched exactly', async () => {
    const bounded = await within({ kind: 'conversation', scope: 'agent-x::a' }, async () =>
      Promise.resolve(boundTurnSearch<SearchTurnsOptions>({ query: 'x' })),
    );
    assert.equal(bounded?.options.agentScopePrefix, 'agent-x::a');
    assert.equal(bounded?.scopeAllowed('agent-x::a'), true);
    assert.equal(bounded?.scopeAllowed('agent-x::ab'), false);
  });

  it('outside a restricted turn the options pass through', async () => {
    const bounded = await within(undefined, async () => Promise.resolve(boundTurnSearch<SearchTurnsOptions>({ query: 'x' })));
    assert.deepEqual(bounded?.options, { query: 'x' });
  });
});
