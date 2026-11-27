/**
 * #2324 / ADR-0302 — a turn origin's channel type is checked against the
 * plugin that states it, on `chatAgent@1`, on `channelResolver@1` answers and
 * on `CoreApi.handleTurnStream`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatTurnInput, CoreApi, IncomingTurn } from '@omadia/channel-sdk';

import { ChannelTypeClaims, scopeCoreApiToChannel } from '../src/channels/scopedCoreApi.js';
import {
  chatAgentBundleFor,
  channelResolverFor,
  createOriginTypeCheck,
  PUBLIC_API_CHANNEL_ID,
} from '../src/channels/turnOriginGuard.js';
import { KERNEL_SERVICE_CALLER } from '../src/platform/serviceRegistry.js';

const TEAMS = '@omadia/channel-teams';
const OTHER = '@acme/sneaky-tool';

const mayState = createOriginTypeCheck((pluginId) =>
  pluginId === TEAMS ? ['teams'] : pluginId === PUBLIC_API_CHANNEL_ID ? ['api'] : ['sneaky'],
);

function recordingAgent(): { agent: ChatAgent; seen: ChatTurnInput[] } {
  const seen: ChatTurnInput[] = [];
  const agent = {
    holdsContentUntilVerdict: true,
    async chat(input: ChatTurnInput) {
      seen.push(input);
      return { text: 'ok' } as never;
    },
    async *chatStream(input: ChatTurnInput) {
      seen.push(input);
    },
  } as unknown as ChatAgent;
  return { agent, seen };
}

const teamsInput = {
  userMessage: 'hi',
  sessionScope: 's',
  userId: '4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
  origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'x' } },
} as unknown as ChatTurnInput;

const caller = (pluginId: string) => ({ agentId: pluginId, pluginId });

describe('ADR-0302 · chatAgent@1 per calling plugin', () => {
  it('keeps the origin of the plugin that holds the channel type', async () => {
    const { agent, seen } = recordingAgent();
    const bundle = chatAgentBundleFor({ agent }, caller(TEAMS), mayState, () => undefined);
    await bundle.agent.chat(teamsInput);
    assert.equal(seen[0]?.origin?.channelType, 'teams');
  });

  it('drops the origin another plugin states, and logs it', async () => {
    const { agent, seen } = recordingAgent();
    const logs: string[] = [];
    const bundle = chatAgentBundleFor({ agent }, caller(OTHER), mayState, (m) => logs.push(m));
    await bundle.agent.chat(teamsInput);
    for await (const _ of bundle.agent.chatStream(teamsInput)) void _;
    assert.equal(seen[0]?.origin, undefined);
    assert.equal(seen[1]?.origin, undefined);
    assert.equal(seen[0]?.userId, teamsInput.userId);
    assert.match(logs[0] ?? '', /security-audit/);
  });

  it('never lets a plugin state http, and api only for the Public API channel', async () => {
    const { agent, seen } = recordingAgent();
    const http = { ...teamsInput, origin: { channelType: 'http', scope: {} } } as unknown as ChatTurnInput;
    const api = { ...teamsInput, origin: { channelType: 'api', scope: {} } } as unknown as ChatTurnInput;
    await chatAgentBundleFor({ agent }, caller(TEAMS), mayState, () => undefined).agent.chat(http);
    await chatAgentBundleFor({ agent }, caller(TEAMS), mayState, () => undefined).agent.chat(api);
    await chatAgentBundleFor({ agent }, caller(PUBLIC_API_CHANNEL_ID), mayState, () => undefined).agent.chat(api);
    assert.equal(seen[0]?.origin, undefined);
    assert.equal(seen[1]?.origin, undefined);
    assert.equal(seen[2]?.origin?.channelType, 'api');
  });

  it('hands the kernel the whole bundle, a plugin only the guarded agent', () => {
    const { agent } = recordingAgent();
    const bundle = { agent, raw: { chat: () => 'unguarded' }, chatSessionStore: {} };
    assert.equal(chatAgentBundleFor(bundle, KERNEL_SERVICE_CALLER, mayState, () => undefined), bundle);
    const wrapped = chatAgentBundleFor(bundle, caller(OTHER), mayState, () => undefined);
    assert.deepEqual(Object.keys(wrapped), ['agent']);
    assert.equal(wrapped.agent.holdsContentUntilVerdict, true);
  });

  it('drops a channelIdentity of a channel the caller does not hold', async () => {
    const { agent, seen } = recordingAgent();
    const forged = {
      userMessage: 'hi',
      sessionScope: 's',
      channelIdentity: { channelKind: 'teams', channelUserId: 'oid' },
    } as unknown as ChatTurnInput;
    await chatAgentBundleFor({ agent }, caller(OTHER), mayState, () => undefined).agent.chat(forged);
    await chatAgentBundleFor({ agent }, caller(TEAMS), mayState, () => undefined).agent.chat(forged);
    assert.equal(seen[0]?.channelIdentity, undefined);
    assert.equal(seen[1]?.channelIdentity?.channelKind, 'teams');
  });
});

describe('ADR-0302 · channelResolver@1 answers', () => {
  it('guards the chatAgent of every resolve() answer', async () => {
    const { agent, seen } = recordingAgent();
    const resolver = { resolve: () => ({ decision: 'bound', chatAgent: agent }) };
    const scoped = channelResolverFor(resolver, caller(OTHER), mayState, () => undefined);
    const answer = scoped.resolve() as { chatAgent: ChatAgent };
    await answer.chatAgent.chat(teamsInput);
    assert.equal(seen[0]?.origin, undefined);
  });
});

describe('ADR-0302 · CoreApi.handleTurnStream', () => {
  function scopedCore(channelId: string, claims: ChannelTypeClaims): { core: CoreApi; turns: IncomingTurn[] } {
    const turns: IncomingTurn[] = [];
    const core = {
      handleTurnStream(turn: IncomingTurn) {
        turns.push(turn);
        return (async function* () {})();
      },
    } as unknown as CoreApi;
    return { core: scopeCoreApiToChannel(core, channelId, claims), turns };
  }

  const turn = (over: Partial<IncomingTurn>): IncomingTurn =>
    ({
      channelId: 'forged',
      text: 'hi',
      userRef: { kind: 'telegram-chat', id: '1' },
      ...over,
    }) as IncomingTurn;

  it('stamps the plugin id and drops a foreign origin', async () => {
    const claims = new ChannelTypeClaims();
    claims.claim(TEAMS, 'teams');
    const { core, turns } = scopedCore('@omadia/channel-telegram', claims);
    for await (const _ of core.handleTurnStream(turn({ metadata: { origin: { channelType: 'teams' }, keep: 1 } })))
      void _;
    assert.equal(turns[0]?.channelId, '@omadia/channel-telegram');
    assert.deepEqual(turns[0]?.metadata, { keep: 1 });
  });

  it('refuses a sender of another channel kind', async () => {
    const claims = new ChannelTypeClaims();
    claims.claim(TEAMS, 'teams');
    const { core, turns } = scopedCore('@omadia/channel-telegram', claims);
    await assert.rejects(async () => {
      for await (const _ of core.handleTurnStream(turn({ userRef: { kind: 'teams-aad', id: 'x' } }))) void _;
    }, /belongs to another channel/);
    assert.equal(turns.length, 0);
  });
});
