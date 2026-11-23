/**
 * #2059 — explicit addressing by agent id (a canvas, a UI with an agent
 * picker): exactly that agent, checked like any routing target, or a
 * `reject` whose ChatAgent answers with the notice naming it. Never another
 * agent, whatever the binding or the default table says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LlmProvider } from '@omadia/llm-provider';
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
    provider: {} as unknown as LlmProvider,
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

const ID = {
  mira: '00000000-0000-0000-0000-0000000000a1',
  tom: '00000000-0000-0000-0000-0000000000a2',
  other: '00000000-0000-0000-0000-0000000000a3',
};

const snap: ConfigSnapshot = {
  agents: [
    agent('mira', ID.mira),
    agent('tom', ID.tom, { status: 'disabled' }),
    agent('other', ID.other, { availableToEveryone: false, availableChannels: ['canvas'] }),
  ],
  agentPlugins: [],
  channelBindings: [],
  defaultEntries: [instanceEntry(ID.mira)],
  availabilityPrincipals: [{ agentId: ID.other, principal: 'user:anna@example.com' }],
};

const target = { channelType: 'canvas', channelKey: 'canvas-1' };

test('#2059: the named agent answers, not the default and not a binding', async () => {
  const registry = await buildRegistry({
    ...snap,
    agents: [...snap.agents, agent('bound', '00000000-0000-0000-0000-0000000000a4')],
    channelBindings: [
      { channelType: 'canvas', channelKey: 'canvas-1', agentId: '00000000-0000-0000-0000-0000000000a4', createdAt: new Date(0) },
    ],
  });
  const resolver = new ChannelResolver({ registry });
  const result = resolver.resolveAgent(ID.mira, target, { principal: 'user:anna@example.com' });
  assert.equal(result.decision, 'bound');
  assert.equal(result.agent?.agent.slug, 'mira');
  assert.equal(result.match, 'explicit');
  assert.equal(result.speaker?.kind, 'agent');
  assert.ok(result.chatAgent);
});

test('#2059: an unknown id is refused with agent_unknown, the default agent stays quiet', async () => {
  const registry = await buildRegistry(snap);
  const result = new ChannelResolver({ registry }).resolveAgent('no-such-id', target, {});
  assert.equal(result.decision, 'reject');
  assert.equal(result.agent, undefined);
  assert.equal(result.notice?.code, 'agent_unknown');
  const done = await noticeAnswerOf(result.chatAgent);
  assert.deepEqual(done?.['speaker'], { kind: 'system' });
});

test('#2059: a disabled agent is refused with agent_disabled naming it', async () => {
  const registry = await buildRegistry(snap);
  const result = new ChannelResolver({ registry }).resolveAgent(ID.tom, target, {});
  assert.equal(result.decision, 'reject');
  assert.equal(result.notice?.code, 'agent_disabled');
  assert.equal(result.notice?.agent?.slug, 'tom');
});

test('#2059: availability is checked for the sender and the channel', async () => {
  const registry = await buildRegistry(snap);
  const resolver = new ChannelResolver({ registry });
  // not available to this sender
  assert.equal(
    resolver.resolveAgent(ID.other, target, { principal: 'user:ben@example.com' }).notice?.code,
    'agent_not_available',
  );
  // no sender at all: an agent that is not available to everyone is not served
  assert.equal(resolver.resolveAgent(ID.other, target, {}).notice?.code, 'agent_not_available');
  // the listed sender, in the listed channel
  assert.equal(resolver.resolveAgent(ID.other, target, { principal: 'user:anna@example.com' }).decision, 'bound');
  // the listed sender in a channel the agent is not offered in
  assert.equal(
    resolver.resolveAgent(ID.other, { channelType: 'teams', channelKey: 'c' }, { principal: 'user:anna@example.com' })
      .notice?.code,
    'agent_not_available',
  );
});

test('#2059: a provisioned bot never answers for another agent, whatever id is named', async () => {
  const registry = await buildRegistry({
    ...snap,
    channelIdentities: [{ channelType: 'teams', channelKey: '28:mira-bot', agentId: ID.mira }],
  });
  const result = new ChannelResolver({ registry }).resolveAgent(
    ID.other,
    { channelType: 'teams', channelKey: '28:mira-bot' },
    { principal: 'user:anna@example.com' },
  );
  assert.equal(result.agent?.agent.slug, 'mira');
  assert.equal(result.exclusive, true);
});
