/**
 * US7 / T032 — channel routing acceptance tests.
 *
 *  1. SC-008 — a bound channel key routes to its owning Agent's
 *     `BuiltOrchestrator`; another bound key routes to a different Agent.
 *  2. T031 — an unbound key routes to the platform fallback Agent when
 *     one is configured, and hard-rejects when none is.
 *  3. T029 — `ensureFallbackAgent` seeds the fallback on first boot
 *     (zero agents → seed), is a no-op when agents already exist with a
 *     fallback set, and points `fallback_agent_id` at an existing seed
 *     row if one is found.
 *  4. Decision logging — every `resolve()` emits exactly one structured
 *     log line carrying channelType, channelKey, decision, and (for
 *     non-reject decisions) the resolved slug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
} from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  type AgentRow,
  type ConfigSnapshot,
  type ConfigStore,
  type PlatformSettingsRow,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import {
  ensureFallbackAgent,
  FALLBACK_AGENT_SLUG,
} from '../packages/harness-orchestrator/src/registry/onboarding.js';
import { ChannelResolver } from '../packages/harness-orchestrator/src/routing/channelResolver.js';

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

function deps(): OrchestratorDeps {
  return {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

function agent(slug: string, id: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const twoAgentSnap: ConfigSnapshot = {
  agents: [
    agent('public', '00000000-0000-0000-0000-000000000001'),
    agent('general', '00000000-0000-0000-0000-000000000002'),
  ],
  agentPlugins: [],
  channelBindings: [
    {
      channelType: 'teams',
      channelKey: '28:public-bot',
      agentId: '00000000-0000-0000-0000-000000000001',
      createdAt: new Date(0),
    },
    {
      channelType: 'telegram',
      channelKey: '@omadia_general_bot',
      agentId: '00000000-0000-0000-0000-000000000002',
      createdAt: new Date(0),
    },
  ],
  platformSettings: {
    fallbackAgentId: '00000000-0000-0000-0000-000000000001',
    updatedAt: new Date(0),
  },
};

function fakeStore(snap: ConfigSnapshot): ConfigStore {
  return {
    loadSnapshot: () => Promise.resolve(snap),
  } as unknown as ConfigStore;
}

async function buildRegistry(snap: ConfigSnapshot): Promise<OrchestratorRegistry> {
  const r = new OrchestratorRegistry(fakeStore(snap), deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await r.start();
  return r;
}

test('SC-008: bound channel keys route to their owning Agent', async () => {
  const registry = await buildRegistry(twoAgentSnap);
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const resolver = new ChannelResolver({
    registry,
    log: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
  });

  const teams = resolver.resolve('teams', '28:public-bot');
  assert.equal(teams.decision, 'bound');
  assert.equal(teams.agent?.agent.slug, 'public');
  assert.ok(teams.chatAgent, 'chatAgent shortcut present on bound result');

  const telegram = resolver.resolve('telegram', '@omadia_general_bot');
  assert.equal(telegram.decision, 'bound');
  assert.equal(telegram.agent?.agent.slug, 'general');

  // Two routes, two log lines, each with the right decision + slug.
  const boundLogs = logs.filter((l) => l.fields?.['decision'] === 'bound');
  assert.equal(boundLogs.length, 2);
});

test('T031: unmatched key routes to the configured fallback Agent', async () => {
  const registry = await buildRegistry(twoAgentSnap);
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const resolver = new ChannelResolver({
    registry,
    log: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
  });

  const result = resolver.resolve('teams', '28:unbound');
  assert.equal(result.decision, 'fallback');
  assert.equal(result.agent?.agent.slug, 'public');

  const fallbackLog = logs.find((l) => l.fields?.['decision'] === 'fallback');
  assert.ok(fallbackLog, 'fallback decision is logged');
});

test('T031: unmatched key hard-rejects when no fallback is configured', async () => {
  const noFallback: ConfigSnapshot = {
    ...twoAgentSnap,
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
  const registry = await buildRegistry(noFallback);
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const resolver = new ChannelResolver({
    registry,
    log: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
  });

  const result = resolver.resolve('teams', '28:unbound');
  assert.equal(result.decision, 'reject');
  assert.equal(result.agent, undefined);
  assert.equal(result.chatAgent, undefined);

  const rejectLog = logs.find((l) => l.fields?.['decision'] === 'reject');
  assert.ok(rejectLog, 'reject decision is logged');
});

test('SC-008: binding-move surfaces on next resolve (registry diff handles in-flight separately)', async () => {
  // First snapshot: teams/28:public-bot → public.
  const registry = await buildRegistry(twoAgentSnap);
  const resolver = new ChannelResolver({ registry });
  assert.equal(
    resolver.resolve('teams', '28:public-bot').agent?.agent.slug,
    'public',
  );

  // Move the binding to `general`.
  const moved: ConfigSnapshot = {
    ...twoAgentSnap,
    channelBindings: [
      {
        channelType: 'teams',
        channelKey: '28:public-bot',
        agentId: '00000000-0000-0000-0000-000000000002',
        createdAt: new Date(0),
      },
      {
        channelType: 'telegram',
        channelKey: '@omadia_general_bot',
        agentId: '00000000-0000-0000-0000-000000000002',
        createdAt: new Date(0),
      },
    ],
  };
  (registry as unknown as {
    store: { loadSnapshot: () => Promise<ConfigSnapshot> };
  }).store.loadSnapshot = () => Promise.resolve(moved);
  await registry.reload();

  assert.equal(
    resolver.resolve('teams', '28:public-bot').agent?.agent.slug,
    'general',
  );
});

test('T029: ensureFallbackAgent seeds on first boot when no agents exist', async () => {
  let createdSlug: string | undefined;
  let fallbackId: string | null = null;
  const store = {
    listAgents: () => Promise.resolve([]),
    getPlatformSettings: () =>
      Promise.resolve<PlatformSettingsRow>({
        fallbackAgentId: null,
        updatedAt: new Date(0),
      }),
    getAgentBySlug: () => Promise.resolve(undefined),
    createAgent: (input: { slug: string }) => {
      createdSlug = input.slug;
      return Promise.resolve(agent(input.slug, '00000000-0000-0000-0000-000000000010'));
    },
    setFallbackAgentId: (id: string | null) => {
      fallbackId = id;
      return Promise.resolve({ fallbackAgentId: id, updatedAt: new Date(0) });
    },
  } as unknown as ConfigStore;

  const slug = await ensureFallbackAgent(store);
  assert.equal(slug, FALLBACK_AGENT_SLUG);
  assert.equal(createdSlug, FALLBACK_AGENT_SLUG);
  assert.equal(fallbackId, '00000000-0000-0000-0000-000000000010');
});

test('T029: ensureFallbackAgent is a no-op when agents exist with a fallback already set', async () => {
  let createCalls = 0;
  let setFallbackCalls = 0;
  const store = {
    listAgents: () => Promise.resolve([agent('a', '1')]),
    getPlatformSettings: () =>
      Promise.resolve<PlatformSettingsRow>({
        fallbackAgentId: '1',
        updatedAt: new Date(0),
      }),
    getAgentBySlug: () => Promise.resolve(undefined),
    createAgent: () => {
      createCalls += 1;
      return Promise.resolve(agent('x', '2'));
    },
    setFallbackAgentId: () => {
      setFallbackCalls += 1;
      return Promise.resolve({ fallbackAgentId: null, updatedAt: new Date(0) });
    },
  } as unknown as ConfigStore;

  const slug = await ensureFallbackAgent(store);
  assert.equal(slug, undefined);
  assert.equal(createCalls, 0);
  assert.equal(setFallbackCalls, 0);
});

test('T029: ensureFallbackAgent refuses to invent a fallback when operator left it unset', async () => {
  let createCalls = 0;
  let setFallbackCalls = 0;
  const store = {
    listAgents: () => Promise.resolve([agent('a', '1')]),
    getPlatformSettings: () =>
      Promise.resolve<PlatformSettingsRow>({
        fallbackAgentId: null,
        updatedAt: new Date(0),
      }),
    getAgentBySlug: () => Promise.resolve(undefined),
    createAgent: () => {
      createCalls += 1;
      return Promise.resolve(agent('x', '2'));
    },
    setFallbackAgentId: () => {
      setFallbackCalls += 1;
      return Promise.resolve({ fallbackAgentId: null, updatedAt: new Date(0) });
    },
  } as unknown as ConfigStore;

  const slug = await ensureFallbackAgent(store);
  assert.equal(slug, undefined, 'should NOT create when operator policy is hard-reject');
  assert.equal(createCalls, 0);
  assert.equal(setFallbackCalls, 0);
});
