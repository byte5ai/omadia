/**
 * US7 × strict per-orchestrator isolation (#201) — integration.
 *
 * Proves the two features compose: a turn that arrives on a *bound* channel is
 * routed by the `ChannelResolver` to its owning Agent (US7), and a memory write
 * on that turn lands in *that Agent's* graph namespace (`<slug>::<conv>`),
 * never another's (#201). Drives the real registry-built `SessionLogger` for
 * each resolved Agent over one shared `KnowledgeGraph` — no LLM, no mocks of
 * the wiring under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  AgentRow,
  ConfigSnapshot,
  ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import { ChannelResolver } from '../packages/harness-orchestrator/src/routing/channelResolver.js';

const A_ID = '00000000-0000-0000-0000-00000000000a';
const B_ID = '00000000-0000-0000-0000-00000000000b';
/** One conversation id both Agents log under — so namespace separation, not a
 *  distinct base id, is what keeps their turns apart. */
const CONV = 'thread-42';

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

function deps(
  memoryStore: InMemoryMemoryStore,
  knowledgeGraph: KnowledgeGraph,
): OrchestratorDeps {
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph,
    memoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

function agent(slug: string, id: string): AgentRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const snapshot: ConfigSnapshot = {
  agents: [agent('agent-a', A_ID), agent('agent-b', B_ID)],
  agentPlugins: [],
  channelBindings: [
    { channelType: 'teams', channelKey: 'key-a', agentId: A_ID, createdAt: new Date(0) },
    { channelType: 'teams', channelKey: 'key-b', agentId: B_ID, createdAt: new Date(0) },
  ],
  // agent-a is also the platform fallback (unbound keys route to it).
  platformSettings: { fallbackAgentId: A_ID, updatedAt: new Date(0) },
};

async function harness(): Promise<{
  registry: OrchestratorRegistry;
  resolver: ChannelResolver;
  graph: InMemoryKnowledgeGraph;
}> {
  const store = new InMemoryMemoryStore();
  const graph = new InMemoryKnowledgeGraph();
  const registry = new OrchestratorRegistry(
    { loadSnapshot: () => Promise.resolve(snapshot) } as unknown as ConfigStore,
    deps(store, graph),
    { defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 } },
  );
  await registry.start();
  return { registry, resolver: new ChannelResolver({ registry }), graph };
}

test('a bound channel turn is logged under its owning Agent\'s graph namespace', async () => {
  const { resolver, graph } = await harness();

  // Two turns, same conversation id, arriving on two different bound keys.
  const routedA = resolver.resolve('teams', 'key-a');
  const routedB = resolver.resolve('teams', 'key-b');
  assert.equal(routedA.decision, 'bound');
  assert.equal(routedB.decision, 'bound');

  // Route → the *resolved* Agent's real, registry-built SessionLogger.
  const slugA = routedA.agent!.agent.slug;
  const slugB = routedB.agent!.agent.slug;
  await routedA.agent!.built.bundle.sessionLogger.log({
    scope: CONV,
    userMessage: 'via teams key-a',
    assistantAnswer: 'ok',
    entityRefs: [],
  });
  await routedB.agent!.built.bundle.sessionLogger.log({
    scope: CONV,
    userMessage: 'via teams key-b',
    assistantAnswer: 'ok',
    entityRefs: [],
  });

  // Each turn lives ONLY under its Agent's qualified scope — no collision on
  // the shared conversation id, no unqualified leak.
  const a = await graph.getSession(`${slugA}::${CONV}`);
  const b = await graph.getSession(`${slugB}::${CONV}`);
  assert.equal(a?.turns.length, 1);
  assert.equal(b?.turns.length, 1);
  assert.equal(a?.turns[0]?.turn.props['userMessage'], 'via teams key-a');
  assert.equal(b?.turns[0]?.turn.props['userMessage'], 'via teams key-b');
  assert.equal(await graph.getSession(CONV), null);
});

test('an unbound channel turn lands in the platform fallback Agent\'s namespace', async () => {
  const { resolver, graph } = await harness();

  const routed = resolver.resolve('teams', 'key-unbound');
  assert.equal(routed.decision, 'fallback');
  assert.equal(routed.agent!.agent.slug, 'agent-a'); // configured fallback

  await routed.agent!.built.bundle.sessionLogger.log({
    scope: CONV,
    userMessage: 'unbound turn',
    assistantAnswer: 'ok',
    entityRefs: [],
  });

  assert.ok(await graph.getSession(`agent-a::${CONV}`));
  // Never the other Agent's tree.
  assert.equal(await graph.getSession(`agent-b::${CONV}`), null);
});
