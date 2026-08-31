/**
 * Provisioned channel identities outrank channel bindings (#860 follow-up).
 *
 * THE BUG THIS PINS DOWN
 * ----------------------
 * Provisioning an agent's own Teams bot writes `agent_teams_identities`
 * (app_id ↔ agent_id) and nothing else. Routing reads `channel_bindings`,
 * which provisioning never touches — so every provisioned bot missed on its
 * own `28:<appId>` key and the registry handed the turn to the platform
 * fallback Agent. Three bots, three Entra apps, three agents, one answering
 * agent. The mapping existed; the resolver was never shown it.
 *
 * The fix makes the identity a first-class, EXCLUSIVE routing input:
 *   - it is matched before any `channel_bindings` row, and
 *   - it reports `exclusive: true` so a less specific key (the shared group
 *     conversation every bot sits in) can never override the bot's own agent.
 *
 * A deployment with no provisioned identities must behave exactly as before —
 * that is what the last test in this file is for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LlmProvider } from '@omadia/llm-provider';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
} from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  AgentRow,
  ConfigSnapshot,
  ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import { ChannelResolver } from '../packages/harness-orchestrator/src/routing/channelResolver.js';

/** The three ids from the field report, shortened. */
const HR_ID = '3f50d98d-5349-49e1-a3fb-a8d61cb0329e';
const MESSIAS_ID = '8b6a1010-da77-4d4f-b789-88b244aa1598';
const FALLBACK_ID = '28e47b63-d9db-4c4a-b3e6-0b51c89c4f99';

/** `activity.recipient.id` of each provisioned bot: `28:` + Entra app id. */
const HR_BOT_KEY = '28:3d78d742-eefb-4fb2-bae5-3687f24c46fc';
const MESSIAS_BOT_KEY = '28:19ad2729-f7d3-4099-9d2a-7da1230c9533';
/** The group chat all three bots share — one key, many bots. */
const GROUP_CHAT = '19:5c8a1f60deadbeef@thread.skype';

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
    provider: {} as LlmProvider,
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
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

const AGENTS: readonly AgentRow[] = [
  agent('hr', HR_ID),
  agent('messias', MESSIAS_ID),
  agent('fallback', FALLBACK_ID),
];

function snapshot(over: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    agents: AGENTS,
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: FALLBACK_ID, updatedAt: new Date(0) },
    ...over,
  };
}

const PROVISIONED: ConfigSnapshot['channelIdentities'] = [
  { channelType: 'teams', channelKey: HR_BOT_KEY, agentId: HR_ID },
  { channelType: 'teams', channelKey: MESSIAS_BOT_KEY, agentId: MESSIAS_ID },
];

function fakeStore(snap: ConfigSnapshot): ConfigStore {
  return { loadSnapshot: () => Promise.resolve(snap) } as unknown as ConfigStore;
}

async function resolverFor(snap: ConfigSnapshot): Promise<ChannelResolver> {
  const registry = new OrchestratorRegistry(fakeStore(snap), deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();
  return new ChannelResolver({ registry });
}

test('two provisioned bots in one chat route to two different agents', async () => {
  const resolver = await resolverFor(
    snapshot({ channelIdentities: PROVISIONED }),
  );

  const hr = resolver.resolve('teams', HR_BOT_KEY);
  const messias = resolver.resolve('teams', MESSIAS_BOT_KEY);

  assert.equal(hr.decision, 'bound');
  assert.equal(hr.agent?.agent.slug, 'hr');
  assert.equal(messias.decision, 'bound');
  assert.equal(messias.agent?.agent.slug, 'messias');
  assert.notEqual(hr.agent?.agent.id, messias.agent?.agent.id);
});

test('a provisioned identity is exclusive — nothing less specific may override it', async () => {
  const resolver = await resolverFor(
    snapshot({ channelIdentities: PROVISIONED }),
  );

  const hr = resolver.resolve('teams', HR_BOT_KEY);
  assert.equal(hr.exclusive, true);
});

test('a group-chat binding does not steal a provisioned bot key', async () => {
  // The operator (or the auto-bind sweep) bound the shared group chat to the
  // HR agent. That binding is legitimate for the chat, but the bot key must
  // still resolve to the bot's OWN agent — and say so exclusively, so the
  // channel adapter knows not to prefer the conversation hit.
  const resolver = await resolverFor(
    snapshot({
      channelIdentities: PROVISIONED,
      channelBindings: [
        {
          channelType: 'teams',
          channelKey: GROUP_CHAT,
          agentId: HR_ID,
          createdAt: new Date(0),
        },
        // …and someone even pointed the bot key itself elsewhere. The
        // provisioned identity is the truth; the stale row loses.
        {
          channelType: 'teams',
          channelKey: MESSIAS_BOT_KEY,
          agentId: HR_ID,
          createdAt: new Date(0),
        },
      ],
    }),
  );

  const conversation = resolver.resolve('teams', GROUP_CHAT);
  assert.equal(conversation.decision, 'bound');
  assert.equal(conversation.agent?.agent.slug, 'hr');
  assert.notEqual(conversation.exclusive, true);

  const messias = resolver.resolve('teams', MESSIAS_BOT_KEY);
  assert.equal(messias.agent?.agent.slug, 'messias');
  assert.equal(messias.exclusive, true);
});

test('an unknown bot key still falls back to the default agent', async () => {
  const resolver = await resolverFor(
    snapshot({ channelIdentities: PROVISIONED }),
  );

  const unknown = resolver.resolve('teams', '28:00000000-0000-0000-0000-000000000000');
  assert.equal(unknown.decision, 'fallback');
  assert.equal(unknown.agent?.agent.slug, 'fallback');
  assert.notEqual(unknown.exclusive, true);
});

test('an identity only claims its own channel type', async () => {
  const resolver = await resolverFor(
    snapshot({ channelIdentities: PROVISIONED }),
  );

  const wrongType = resolver.resolve('telegram', HR_BOT_KEY);
  assert.equal(wrongType.decision, 'fallback');
  assert.equal(wrongType.agent?.agent.slug, 'fallback');
});

test('an identity pointing at a disabled/absent agent degrades to the old path', async () => {
  // The agent row is gone (deleted) but the identity row survived. Routing
  // must not dead-end: fall through to bindings, then the platform fallback.
  const resolver = await resolverFor(
    snapshot({
      channelIdentities: [
        { channelType: 'teams', channelKey: HR_BOT_KEY, agentId: 'ghost' },
      ],
    }),
  );

  const hr = resolver.resolve('teams', HR_BOT_KEY);
  assert.equal(hr.decision, 'fallback');
  assert.equal(hr.agent?.agent.slug, 'fallback');
});

test('a deployment without provisioned identities behaves exactly as before', async () => {
  const resolver = await resolverFor(
    snapshot({
      channelBindings: [
        {
          channelType: 'teams',
          channelKey: GROUP_CHAT,
          agentId: MESSIAS_ID,
          createdAt: new Date(0),
        },
      ],
    }),
  );

  const bound = resolver.resolve('teams', GROUP_CHAT);
  assert.equal(bound.decision, 'bound');
  assert.equal(bound.agent?.agent.slug, 'messias');
  assert.equal(bound.exclusive, undefined);

  const unbound = resolver.resolve('teams', HR_BOT_KEY);
  assert.equal(unbound.decision, 'fallback');
  assert.equal(unbound.agent?.agent.slug, 'fallback');
  assert.equal(unbound.exclusive, undefined);
});

test('identity routing survives a reload that changes nothing else', async () => {
  // The provisioning run writes `app_id` long after boot. The registry picks
  // it up on its next reconcile — even though the agent/plugin/binding diff
  // is empty and the fast path skips `applyDiffActions` entirely.
  let snap = snapshot();
  const store = {
    loadSnapshot: () => Promise.resolve(snap),
  } as unknown as ConfigStore;
  const registry = new OrchestratorRegistry(store, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();
  const resolver = new ChannelResolver({ registry });

  assert.equal(resolver.resolve('teams', HR_BOT_KEY).agent?.agent.slug, 'fallback');

  snap = snapshot({ channelIdentities: PROVISIONED });
  const plan = await registry.reload();
  assert.equal(plan.actions.length, 0, 'no agent-level change — fast path');

  const after = resolver.resolve('teams', HR_BOT_KEY);
  assert.equal(after.agent?.agent.slug, 'hr');
  assert.equal(after.exclusive, true);
});

test('the routing decision is logged with its match source', async () => {
  const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const registry = new OrchestratorRegistry(
    fakeStore(snapshot({ channelIdentities: PROVISIONED })),
    deps(),
    { defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 } },
  );
  await registry.start();
  const resolver = new ChannelResolver({
    registry,
    log: (msg, fields) => lines.push({ msg, ...(fields ? { fields } : {}) }),
  });

  resolver.resolve('teams', HR_BOT_KEY);

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.fields?.match, 'identity');
  assert.equal(lines[0]?.fields?.slug, 'hr');
  assert.equal(lines[0]?.fields?.agentId, HR_ID);
});
