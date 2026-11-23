/**
 * US7 / T032 — channel routing acceptance tests.
 *
 *  1. SC-008 — a bound channel key routes to its owning Agent's
 *     `BuiltOrchestrator`; another bound key routes to a different Agent.
 *  2. #2055 — there is no fallback agent: an unbound key routes to the
 *     instance entry of the default-agent table, and is rejected with a
 *     `no_agent` notice when that entry is `off` or missing.
 *  3. #2055 / #1880 — a binding to a disabled agent is rejected with
 *     `agent_disabled` naming it; the default agent does not answer instead.
 *  4. Decision logging — every `resolve()` emits exactly one structured
 *     log line carrying channelType, channelKey, decision, and the match.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import type { ChatAgent } from '@omadia/channel-sdk';
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
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import type { DefaultAgentEntryRow } from '../packages/harness-orchestrator/src/registry/routingTables.js';
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
    availableToEveryone: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** The instance entry of the default-agent table (the former fallback). */
function instanceEntry(agentId: string | null): DefaultAgentEntryRow {
  return {
    id: 'entry-instance',
    principal: null,
    channelType: null,
    agentId,
    updatedBy: null,
    updatedAt: new Date(0),
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
  defaultEntries: [instanceEntry('00000000-0000-0000-0000-000000000001')],
};

function fakeStore(snap: ConfigSnapshot): ConfigStore {
  return {
    loadSnapshot: () => Promise.resolve(snap),
  } as unknown as ConfigStore;
}

/**
 * #2055 — a reject still hands out a ChatAgent: the management layer with no
 * agent behind it. Whatever the sender writes, it answers with the notice,
 * from `system`, without running a model.
 */
async function noticeAnswerOf(chatAgent: ChatAgent): Promise<Record<string, unknown> | undefined> {
  const events: Array<Record<string, unknown>> = [];
  for await (const ev of chatAgent.chatStream({ userMessage: 'hi', sessionScope: 's' } as never)) {
    events.push(ev as unknown as Record<string, unknown>);
  }
  assert.equal(events.length, 1, 'one done event, no agent output');
  return events[0];
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

test('#2055: unmatched key routes to the instance default agent', async () => {
  const registry = await buildRegistry(twoAgentSnap);
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const resolver = new ChannelResolver({
    registry,
    log: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
  });

  const result = resolver.resolve('teams', '28:unbound');
  assert.equal(result.decision, 'bound');
  assert.equal(result.match, 'default');
  assert.equal(result.exclusive, false);
  assert.equal(result.agent?.agent.slug, 'public');

  const defaultLog = logs.find((l) => l.fields?.['match'] === 'default');
  assert.equal(defaultLog?.fields?.['decision'], 'bound', 'the default decision is logged');
});

for (const [label, defaultEntries] of [
  ['set to off', [instanceEntry(null)]],
  ['missing', []],
] as const) {
  test(`#2055: unmatched key is rejected with no_agent when the instance entry is ${label}`, async () => {
    const registry = await buildRegistry({ ...twoAgentSnap, defaultEntries });
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const resolver = new ChannelResolver({
      registry,
      log: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
    });

    const result = resolver.resolve('teams', '28:unbound');
    assert.equal(result.decision, 'reject');
    assert.equal(result.agent, undefined);
    assert.equal(result.notice?.code, 'no_agent');
    const done = await noticeAnswerOf(result.chatAgent);
    assert.deepEqual(done?.['speaker'], { kind: 'system' });
    assert.equal((done?.['systemNotice'] as { code?: string } | undefined)?.code, 'no_agent');
    assert.equal(result.match, undefined, 'nothing addressed an agent');

    const rejectLog = logs.find((l) => l.fields?.['decision'] === 'reject');
    assert.equal(rejectLog?.fields?.['notice'], 'no_agent', 'reject decision is logged');
  });
}

test('#2055/#1880: a binding to a disabled agent is rejected naming it; the default agent does not answer', async () => {
  const registry = await buildRegistry({
    ...twoAgentSnap,
    agents: [
      twoAgentSnap.agents[0]!,
      agent('general', '00000000-0000-0000-0000-000000000002', { status: 'disabled' }),
    ],
  });
  const resolver = new ChannelResolver({ registry });

  const result = resolver.resolve('telegram', '@omadia_general_bot', { locale: 'en' });
  assert.equal(result.decision, 'reject');
  assert.equal(result.agent, undefined);
  assert.equal(result.match, 'binding');
  assert.equal(result.notice?.code, 'agent_disabled');
  assert.equal(result.notice?.agent?.slug, 'general');
  assert.match(result.notice?.text ?? '', /general is currently disabled/);
  const done = await noticeAnswerOf(result.chatAgent);
  assert.deepEqual(done?.['speaker'], { kind: 'system' });
  assert.equal(done?.['answer'], result.notice?.text, 'the notice is the answer, not the default agent');
});

test('#2055: an agent available to nobody is not served, not even through its binding', async () => {
  const registry = await buildRegistry({
    ...twoAgentSnap,
    agents: [
      twoAgentSnap.agents[0]!,
      agent('general', '00000000-0000-0000-0000-000000000002', { availableToEveryone: false }),
    ],
  });
  const resolver = new ChannelResolver({ registry });

  const anonymous = resolver.resolve('telegram', '@omadia_general_bot');
  assert.equal(anonymous.decision, 'reject');
  assert.equal(anonymous.notice?.code, 'agent_not_available');

  // Named availability: the listed person is served.
  const named = await buildRegistry({
    ...twoAgentSnap,
    agents: [
      twoAgentSnap.agents[0]!,
      agent('general', '00000000-0000-0000-0000-000000000002', { availableToEveryone: false }),
    ],
    availabilityPrincipals: [
      { agentId: '00000000-0000-0000-0000-000000000002', principal: 'user:anna@example.com' },
    ],
  });
  const forAnna = new ChannelResolver({ registry: named }).resolve('telegram', '@omadia_general_bot', {
    principal: 'user:anna@example.com',
  });
  assert.equal(forAnna.decision, 'bound');
  assert.equal(forAnna.agent?.agent.slug, 'general');
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

test('#2060: a binding to a facilitator is rejected at resolve time, never answered through a foreign bot', async () => {
  const mara = '00000000-0000-0000-0000-0000000000f1';
  const registry = await buildRegistry({
    ...twoAgentSnap,
    agents: [...twoAgentSnap.agents, agent('mara', mara, { archetype: 'facilitator' })],
    channelBindings: [
      ...twoAgentSnap.channelBindings,
      // The default bot's key, bound to the facilitator by hand.
      { channelType: 'teams', channelKey: '28:default-bot', agentId: mara, createdAt: new Date(0) },
    ],
    // …while its OWN bot routes to it.
    channelIdentities: [{ channelType: 'teams', channelKey: '28:mara-bot', agentId: mara }],
  } as ConfigSnapshot);
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const resolver = new ChannelResolver({
    registry,
    log: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
  });

  const viaBinding = resolver.resolve('teams', '28:default-bot');
  assert.equal(viaBinding.decision, 'reject');
  assert.equal(viaBinding.agent, undefined);
  assert.equal(viaBinding.notice?.code, 'agent_not_available');
  assert.equal(viaBinding.notice?.agent?.slug, 'mara');
  assert.equal(logs.at(-1)?.fields?.['match'], 'binding');
  assert.equal(logs.at(-1)?.fields?.['notice'], 'agent_not_available');

  const viaIdentity = resolver.resolve('teams', '28:mara-bot');
  assert.equal(viaIdentity.decision, 'bound');
  assert.equal(viaIdentity.exclusive, true);
  assert.equal(viaIdentity.agent?.agent.slug, 'mara');
  // A standard agent's binding is untouched.
  assert.equal(resolver.resolve('teams', '28:public-bot').agent?.agent.slug, 'public');
});

test('#2088: a conversation bound to a deleted agent is refused; the default agent does not answer in its place', async () => {
  const gone = '00000000-0000-0000-0000-0000000000d1';
  const snapshot = {
    ...twoAgentSnap,
    // The deleted agent is in no agent list; its binding and its bot's
    // identity row are still there (the row is a tombstone, nothing cascaded).
    channelBindings: [
      ...twoAgentSnap.channelBindings,
      { channelType: 'teams', channelKey: '19:sales-team@thread.v2', agentId: gone, createdAt: new Date(0) },
    ],
    channelIdentities: [{ channelType: 'teams', channelKey: '28:gone-bot', agentId: gone }],
    tombstones: [
      { id: gone, slug: 'mira', name: 'Mira', archetype: 'standard', deletedAt: '2026-11-19T10:00:00.000Z', deletedBy: null },
    ],
  } as ConfigSnapshot;
  const registry = await buildRegistry(snapshot);
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const resolver = new ChannelResolver({
    registry,
    log: (msg, fields) => logs.push({ msg, ...(fields ? { fields } : {}) }),
  });

  // The default agent exists and answers an unbound conversation.
  const elsewhere = resolver.resolve('teams', '19:somewhere-else@thread.v2');
  assert.equal(elsewhere.decision, 'bound');
  assert.equal(elsewhere.match, 'default');

  const bound = resolver.resolve('teams', '19:sales-team@thread.v2', { locale: 'en' });
  assert.equal(bound.decision, 'reject');
  assert.equal(bound.agent, undefined);
  assert.equal(logs.at(-1)?.fields?.['match'], 'binding');
  assert.equal(logs.at(-1)?.fields?.['agentId'], gone);
  // "Mira was deleted" — the notice names the agent (#2045, INV-7).
  assert.equal(bound.notice?.code, 'agent_deleted');
  assert.deepEqual(bound.notice?.agent, { slug: 'mira', displayName: 'Mira', agentId: gone });
  assert.match(bound.notice?.text ?? '', /^Mira was deleted/);
  assert.equal((await noticeAnswerOf(bound.chatAgent))?.['answer'], bound.notice?.text);

  // Its own bot goes quiet as well, by the same rule; the reject is exclusive.
  const ownBot = resolver.resolve('teams', '28:gone-bot');
  assert.equal(ownBot.decision, 'reject');
  assert.equal(ownBot.exclusive, true);
  assert.equal(ownBot.notice?.code, 'agent_deleted');
  assert.equal(logs.at(-1)?.fields?.['match'], 'identity');

  // The refusal survives a reload: the binding is kept until somebody changes the target.
  await registry.reload();
  assert.equal(registry.deletedBindingOwnerFor('teams', '19:sales-team@thread.v2')?.name, 'Mira');
});
