/**
 * The side doors past a restricted turn's graph boundary, closed.
 *
 * The recall legs and the in-process `query_knowledge_graph` honour a turn's
 * boundary: `enforce-strict` / `members`, and in `off` / `enforce` this
 * agent's chats of the turn's user (#2204). Three other ways to read the graph
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
import { nativeToolResultText, type SearchTurnsOptions } from '@omadia/plugin-api';

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
    userId: 'u-a',
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
  // It knows no turn, so no user either: nothing, in every mode (#2204).
  // The plugin tests below show the same graph does hold the secret.
  for (const mode of ['off', 'enforce', 'enforce-strict', 'members'] as const) {
    it(`sees nothing for an agent in ${mode}`, async () => {
      const handler = agent(await graphWithSecret(), mode).get('query_knowledge_graph')?.handler;
      assert.ok(handler, 'the graph tool is not registered');
      assert.doesNotMatch(nativeToolResultText(await handler(search)), /4,2 Mio/);
    });
  }
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

  it('off / enforce: only turns of this agent the turn’s user sent (#2204)', async () => {
    const graph = await graphWithSecret();
    const run = (userId: string, prefix: string): Promise<number> =>
      within({ kind: 'user', userId, agentScopePrefix: prefix, ownScope: null }, async () => {
        const bounded = boundTurnSearch<SearchTurnsOptions>({ query: 'Kranich' });
        if (!bounded) return -1;
        return (await graph.searchTurns(bounded.options)).filter((h) => bounded.scopeAllowed(h.scope)).length;
      });
    assert.equal(await run('u-a', 'agent-x::'), 1);
    assert.equal(await run('u-b', 'agent-x::'), 0, 'another user, though an owner of the room');
    assert.equal(await run('u-a', 'agent-y::'), 0, 'another agent');
  });

  it('an unknown room, a context-free turn of such an agent, no conversation, or no user: nothing', async () => {
    for (const value of [
      { kind: 'user', userId: null, agentScopePrefix: 'agent-x::', ownScope: null },
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

  it('ADR-0044: no boundary set (a turn before binding, or no turn) sees nothing', async () => {
    assert.equal(await within(undefined, async () => Promise.resolve(boundTurnSearch<SearchTurnsOptions>({ query: 'x' }))), null);
    assert.equal(boundTurnSearch<SearchTurnsOptions>({ query: 'x' }), null);
  });
});
