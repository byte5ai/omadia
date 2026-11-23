/**
 * Spec 2042 §5.3, §8 item 20 — an agent's own bot on Telegram (and every
 * other non-Teams channel) routes like a provisioned Teams bot.
 *
 * The rows come from `agent_channel_identities` (migration 0105) through
 * `ConfigStore.listChannelIdentities`; routing sees only the generic
 * `ChannelIdentityRow`. What is pinned here:
 *
 *   - a turn through agent X's bot goes to X, exclusively, whatever the group
 *     conversation is bound to and whatever the sender selected;
 *   - two agent bots and the shared bot in one Telegram group stay apart;
 *   - `/agent` sent to an own bot answers whose bot it is and stores nothing;
 *   - the bot of a deleted agent is refused, never answered by someone else;
 *   - without an own bot, the shared bot keeps the old path (selection,
 *     binding, default agent).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LlmProvider } from '@omadia/llm-provider';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';
import type { AgentSelectionService } from '@omadia/channel-sdk';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow, ConfigSnapshot, ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import { ChannelResolver } from '../packages/harness-orchestrator/src/routing/channelResolver.js';

const MIRA_ID = '0b6f4c6e-1111-4c4a-b3e6-0b51c89c4f01';
const OTTO_ID = '0b6f4c6e-2222-4c4a-b3e6-0b51c89c4f02';
const DEFAULT_ID = '0b6f4c6e-3333-4c4a-b3e6-0b51c89c4f03';

/** Telegram routing keys as the plugin returns them: `tg:<botId>`. */
const MIRA_BOT = 'tg:7000000001';
const OTTO_BOT = 'tg:7000000002';
/** A Telegram group chat id every bot sits in. */
const GROUP = '-1002000000001';
const SENDER = 'user:telegram-user:42';

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
    availableToEveryone: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function snapshot(over: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  return {
    agents: [agent('mira', MIRA_ID), agent('otto', OTTO_ID), agent('standard', DEFAULT_ID)],
    agentPlugins: [],
    channelBindings: [],
    channelIdentities: [
      { channelType: 'telegram', channelKey: MIRA_BOT, agentId: MIRA_ID },
      { channelType: 'telegram', channelKey: OTTO_BOT, agentId: OTTO_ID },
    ],
    defaultEntries: [
      { id: 'entry-instance', principal: null, channelType: null, agentId: DEFAULT_ID, updatedBy: null, updatedAt: new Date(0) },
    ],
    ...over,
  };
}

function recordingSelection(): AgentSelectionService & { calls: number } {
  const service = {
    calls: 0,
    handle() {
      service.calls += 1;
      return Promise.resolve({ code: 'agent_selected', text: 'selected', locale: 'en' } as never);
    },
  };
  return service as unknown as AgentSelectionService & { calls: number };
}

async function resolverFor(snap: ConfigSnapshot, selection?: AgentSelectionService): Promise<ChannelResolver> {
  const registry = new OrchestratorRegistry(
    { loadSnapshot: () => Promise.resolve(snap) } as unknown as ConfigStore,
    deps(),
    { defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 } },
  );
  await registry.start();
  return new ChannelResolver({ registry, ...(selection ? { selection } : {}) });
}

test('two agent bots in one Telegram group route to their own agents, exclusively', async () => {
  const resolver = await resolverFor(snapshot());
  const mira = resolver.resolve('telegram', MIRA_BOT);
  const otto = resolver.resolve('telegram', OTTO_BOT);
  assert.equal(mira.agent?.agent.slug, 'mira');
  assert.equal(mira.exclusive, true);
  assert.equal(mira.match, 'identity');
  assert.equal(otto.agent?.agent.slug, 'otto');
  assert.equal(otto.exclusive, true);
});

test("a group binding or a sender's selection never takes an agent's own bot", async () => {
  const resolver = await resolverFor(
    snapshot({
      channelBindings: [{ channelType: 'telegram', channelKey: GROUP, agentId: OTTO_ID, createdAt: new Date(0) }],
      selections: [
        { channelType: 'telegram', conversationKey: MIRA_BOT, principal: SENDER, agentId: OTTO_ID, selectedAt: new Date(0) },
      ],
    }),
  );
  const viaMira = resolver.resolve('telegram', MIRA_BOT, { principal: SENDER });
  assert.equal(viaMira.agent?.agent.slug, 'mira');
  assert.equal(viaMira.exclusive, true);
  // The group itself stays the binding's: that is what the shared bot answers.
  const group = resolver.resolve('telegram', GROUP, { principal: SENDER });
  assert.equal(group.agent?.agent.slug, 'otto');
  assert.notEqual(group.exclusive, true);
});

test('without an own bot the shared bot keeps the selection and default path', async () => {
  const resolver = await resolverFor(
    snapshot({
      selections: [
        { channelType: 'telegram', conversationKey: GROUP, principal: SENDER, agentId: OTTO_ID, selectedAt: new Date(0) },
      ],
    }),
  );
  assert.equal(resolver.resolve('telegram', GROUP, { principal: SENDER }).agent?.agent.slug, 'otto');
  const stranger = resolver.resolve('telegram', GROUP, { principal: 'user:telegram-user:7' });
  assert.equal(stranger.match, 'default');
  assert.equal(stranger.agent?.agent.slug, 'standard');
});

test("/agent sent to an agent's own bot says whose bot it is and selects nothing", async () => {
  const selection = recordingSelection();
  const resolver = await resolverFor(snapshot(), selection);
  const routed = resolver.resolve('telegram', MIRA_BOT, { principal: SENDER, locale: 'en' });
  const answer = await routed.chatAgent!.chat({ userMessage: '/agent otto', sessionScope: 's', userId: 'u' } as never);
  assert.equal(answer.systemNotice?.code, 'agent_own_bot');
  assert.equal(answer.systemNotice?.agent?.slug, 'mira');
  assert.equal(answer.speaker?.kind, 'system');
  assert.equal(selection.calls, 0, 'no selection is stored on an own bot');
});

test('/agent on the shared bot still stores the selection', async () => {
  const selection = recordingSelection();
  const resolver = await resolverFor(snapshot(), selection);
  const routed = resolver.resolve('telegram', GROUP, { principal: SENDER });
  await routed.chatAgent!.chat({ userMessage: '/agent otto', sessionScope: 's', userId: 'u' } as never);
  assert.equal(selection.calls, 1);
});

test("the bot of a deleted agent is refused, never answered by the default agent", async () => {
  const snap = snapshot();
  const resolver = await resolverFor({
    ...snap,
    agents: snap.agents.filter((a) => a.id !== MIRA_ID),
    tombstones: [{ id: MIRA_ID, slug: 'mira', name: 'Mira', deletedAt: new Date(0) } as never],
  });
  const viaMira = resolver.resolve('telegram', MIRA_BOT);
  assert.equal(viaMira.decision, 'reject');
  assert.equal(viaMira.agent, undefined);
  assert.equal(viaMira.exclusive, true);
});

test('an identity only claims its own channel type', async () => {
  const resolver = await resolverFor(snapshot());
  const discord = resolver.resolve('discord', MIRA_BOT);
  assert.equal(discord.match, 'default');
  assert.equal(discord.agent?.agent.slug, 'standard');
});

// ── Teams: the identity comes from `agent_teams_identities` (`28:<appId>`) ──

const MONA_ID = '0b6f4c6e-4444-4c4a-b3e6-0b51c89c4f04';
const MONA_BOT = '28:3d78d742-eefb-4fb2-bae5-3687f24c46fc';
const PERSONAL_CHAT = 'a:1xyzpersonalchat';

function teamsSnapshot(): ConfigSnapshot {
  const base = snapshot();
  return {
    ...base,
    agents: [...base.agents, { ...agent('mona', MONA_ID), name: 'Mona' }],
    // The projection `ConfigStore.listChannelIdentities` builds from 0049.
    channelIdentities: [{ channelType: 'teams', channelKey: MONA_BOT, agentId: MONA_ID }],
    // A selection someone stored in Mona's personal bot chat before S7.
    selections: [
      { channelType: 'teams', conversationKey: PERSONAL_CHAT, principal: SENDER, agentId: OTTO_ID, selectedAt: new Date(0) },
    ],
  };
}

test("Teams: /agent in a provisioned agent's own bot chat says whose bot it is and selects nothing (live finding)", async () => {
  const selection = recordingSelection();
  const resolver = await resolverFor(teamsSnapshot(), selection);
  // What channel-teams does (`pickTurnDecision`): the bot key first; an
  // exclusive hit wins and its ChatAgent also carries out `/agent`.
  const viaBot = resolver.resolve('teams', MONA_BOT, { principal: SENDER, locale: 'en' });
  assert.equal(viaBot.exclusive, true);
  assert.equal(viaBot.agent?.agent.slug, 'mona');
  const answer = await viaBot.chatAgent!.chat({ userMessage: '/agent otto', sessionScope: 's', userId: 'u' } as never);
  assert.equal(answer.systemNotice?.code, 'agent_own_bot');
  assert.equal(answer.systemNotice?.agent?.slug, 'mona');
  assert.equal(answer.systemNotice?.locale, 'en');
  assert.match(answer.text, /Mona's own bot/);
  assert.equal(selection.calls, 0);
  // The stale selection on the chat does not take the bot either.
  assert.equal(resolver.resolve('teams', PERSONAL_CHAT, { principal: SENDER }).agent?.agent.slug, 'otto');
  assert.equal(viaBot.agent?.agent.slug, 'mona');
});

test("the routed agent receives the turn's language (for its identity-guard notice)", async () => {
  const resolver = await resolverFor(teamsSnapshot());
  const viaBot = resolver.resolve('teams', MONA_BOT, { principal: SENDER, locale: 'en' });
  const seen: Array<string | undefined> = [];
  const inner = viaBot.agent!.built.bundle.agent as unknown as { chat: (i: { locale?: string }) => Promise<unknown> };
  const original = inner.chat;
  inner.chat = async (input) => {
    seen.push(input.locale);
    return { text: 'ok' };
  };
  try {
    await viaBot.chatAgent!.chat({ userMessage: 'hello', sessionScope: 's', userId: 'u' } as never);
  } finally {
    inner.chat = original;
  }
  assert.deepEqual(seen, ['en']);
});
