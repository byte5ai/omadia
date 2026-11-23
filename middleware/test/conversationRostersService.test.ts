/**
 * #2043 rollout — a roster is read AS the facilitator.
 *
 * The first live facilitation opened with an empty participant list: the
 * roster contract carried no agent and no channel key, so the Teams adapter
 * read the roster through the instance's default bot, which is not in the
 * facilitator's chat.
 *
 * These tests go through the service object exactly as a plugin gets it
 * (`serviceRegistry.get('conversationRosters', { pluginId })`) and call it
 * the way the facilitator plugin 1.0.3 does: three positional arguments.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ConversationRoster } from '@omadia/channel-sdk';

import { ConversationRosterRegistry } from '../src/channels/rosterRegistry.js';
import {
  publishConversationRostersService,
  type ConversationRostersService,
} from '../src/channels/rosterService.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';

const ENGINE = '@omadia/agent-facilitator';
const MONA_KEY = '28:6e7d5e84-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const CHAT = '19:meeting_abc@thread.v2';

const rosterAs = (who: string): ConversationRoster => ({
  conversationType: 'group',
  partial: false,
  status: 'complete',
  participants: [{ userRef: { kind: 'teams-aad', id: 'u-anna', displayName: `Anna (seen by ${who})` } }],
});

function setup(opts: { engine?: string | null } = {}) {
  const asked: unknown[][] = [];
  const logs: string[] = [];
  const registry = new ConversationRosterRegistry();
  registry.register('@omadia/channel-teams', {
    channelType: 'teams',
    // Declared with rest arguments so the test sees EXACTLY what arrives.
    getRoster: (...args: unknown[]) => {
      asked.push(args);
      const key = (args[1] as { asChannelKey?: string } | undefined)?.asChannelKey;
      // The default bot is not in this chat; the facilitator's bot is.
      return Promise.resolve(key === MONA_KEY ? rosterAs('mona') : undefined);
    },
  } as never);
  const serviceRegistry = new ServiceRegistry();
  publishConversationRostersService({
    serviceRegistry,
    registry,
    identityFor: (slug, type) => (slug === 'mona' && type === 'teams' ? { channelKey: MONA_KEY } : undefined),
    isEngine: (pluginId) => pluginId === (opts.engine === undefined ? ENGINE : opts.engine),
    log: (m) => logs.push(m),
  });
  const as = (pluginId: string): ConversationRostersService => {
    const service = serviceRegistry.get<ConversationRostersService>('conversationRosters', { pluginId } as never);
    assert.ok(service);
    return service;
  };
  return { as, asked, logs, registry, serviceRegistry };
}

describe("'conversationRosters' as a plugin calls it", () => {
  it('the engine, three positional arguments: the roster is read as the facilitator, not as the default bot', async () => {
    const h = setup();
    const roster = await h.as(ENGINE).getRoster('teams', CHAT, { agentSlug: 'mona' });
    assert.deepEqual(roster, rosterAs('mona'));
    assert.deepEqual(h.asked, [[CHAT, { asChannelKey: MONA_KEY }]], 'the third argument reached the channel as its identity');
  });

  it('without the option nothing changes: one argument to the provider, the default identity', async () => {
    const h = setup();
    assert.equal(await h.as(ENGINE).getRoster('teams', CHAT), undefined, 'the default bot is not in that chat');
    await h.as('@acme/some-plugin').getRoster('teams', CHAT, {});
    assert.deepEqual(h.asked, [[CHAT], [CHAT]], 'exactly the call a provider always got');
  });

  it('an agent without an identity on that channel: unknown, never another bot view', async () => {
    const h = setup();
    assert.equal(await h.as(ENGINE).getRoster('teams', CHAT, { agentSlug: 'hr' }), undefined);
    assert.equal(await h.as(ENGINE).getRoster('slack', CHAT, { agentSlug: 'mona' }), undefined);
    assert.deepEqual(h.asked, [], 'the channel was not asked at all');
    assert.match(h.logs.join('\n'), /agent 'hr' has no identity of its own on 'teams'/);
  });

  it('only the facilitation engine may read a roster as an agent', async () => {
    const h = setup();
    assert.equal(await h.as('@acme/snoop').getRoster('teams', CHAT, { agentSlug: 'mona' }), undefined);
    assert.deepEqual(h.asked, []);
    assert.match(h.logs.join('\n'), /'@acme\/snoop' asked for the roster .* as agent 'mona' — refused/);
    // And a plugin that used to be the engine is one of the others.
    const former = setup({ engine: null });
    assert.equal(await former.as(ENGINE).getRoster('teams', CHAT, { agentSlug: 'mona' }), undefined);
  });

  it('the kernel itself may ask as an agent, and `types` is still there', async () => {
    const h = setup();
    const kernel = h.serviceRegistry.get<ConversationRostersService>('conversationRosters');
    assert.deepEqual(await kernel?.getRoster('teams', CHAT, { agentSlug: 'mona' }), rosterAs('mona'));
    assert.deepEqual(h.as(ENGINE).types(), ['teams']);
  });

  it('a throwing provider is still "unknown"', async () => {
    const registry = new ConversationRosterRegistry();
    registry.register('c', {
      channelType: 'teams',
      getRoster: () => Promise.reject(new Error('graph 403')),
    });
    assert.equal(await registry.getRoster('teams', CHAT, { asChannelKey: MONA_KEY }), undefined);
  });
});

describe('roster status and a fresh read (#2091)', () => {
  function withProvider(answer: Partial<ConversationRoster> | undefined) {
    const asked: unknown[][] = [];
    const registry = new ConversationRosterRegistry();
    registry.register('c', {
      channelType: 'teams',
      getRoster: (...args: unknown[]) => {
        asked.push(args);
        return Promise.resolve(
          answer ? ({ conversationType: 'group', participants: [], partial: false, ...answer } as ConversationRoster) : undefined,
        );
      },
    } as never);
    const serviceRegistry = new ServiceRegistry();
    publishConversationRostersService({
      serviceRegistry,
      registry,
      identityFor: () => ({ channelKey: MONA_KEY }),
      isEngine: (pluginId) => pluginId === ENGINE,
    });
    const service = serviceRegistry.get<ConversationRostersService>('conversationRosters', { pluginId: ENGINE } as never)!;
    return { asked, service };
  }

  it('a provider that predates `status` gets it derived from `partial`', async () => {
    assert.equal((await withProvider({ partial: false }).service.getRoster('teams', CHAT))?.status, 'complete');
    assert.equal((await withProvider({ partial: true }).service.getRoster('teams', CHAT))?.status, 'partial');
  });

  it("the provider's own status, time and reason pass through unchanged", async () => {
    const roster = await withProvider({
      partial: true,
      status: 'unknown',
      readAt: '2026-11-19T09:00:00.000Z',
      statusDetail: 'RSC permission missing',
    }).service.getRoster('teams', CHAT);
    assert.deepEqual(
      [roster?.status, roster?.readAt, roster?.statusDetail, roster?.partial],
      ['unknown', '2026-11-19T09:00:00.000Z', 'RSC permission missing', true],
    );
  });

  it('`fresh` reaches the channel, with and without an agent; absent it is not sent', async () => {
    const h = withProvider({ partial: false });
    await h.service.getRoster('teams', CHAT, { agentSlug: 'mona', fresh: true });
    await h.service.getRoster('teams', CHAT, { fresh: true });
    await h.service.getRoster('teams', CHAT, { agentSlug: 'mona' });
    await h.service.getRoster('teams', CHAT, { fresh: false });
    assert.deepEqual(h.asked, [
      [CHAT, { asChannelKey: MONA_KEY, fresh: true }],
      [CHAT, { fresh: true }],
      [CHAT, { asChannelKey: MONA_KEY }],
      [CHAT],
    ]);
  });

  it('a channel that cannot resolve the conversation stays "unknown" (undefined)', async () => {
    assert.equal(await withProvider(undefined).service.getRoster('teams', CHAT, { fresh: true }), undefined);
  });
});
