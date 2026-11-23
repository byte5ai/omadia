/**
 * Live E2E 2026-11-23 (spec 2042, criteria 21/22/26) — "anything new since
 * the last firing?" compares two moments on one clock, counts a message at
 * the very instant of the last firing as news, and never books a bot's own
 * post, reported back by its channel, as news.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { storeContextChecks } from '../src/triggers/contextChecks.js';
import { DEFAULT_TRIGGER_LIMITS } from '../src/triggers/triggerPolicy.js';
import { TriggerService } from '../src/triggers/triggerService.js';
import type { TriggerStore } from '../src/triggers/triggerStore.js';
import type { Occurrence, Trigger } from '../src/triggers/types.js';

const OCC = {} as Occurrence;

const T0 = new Date('2026-11-23T10:00:00Z');

const checksWith = (lastActivityAt: Date | undefined) =>
  storeContextChecks({
    contextActivity: async () => (lastActivityAt ? { lastActivityAt, endedAt: null } : undefined),
  } as unknown as TriggerStore);

const trigger = (lastFiredAt: Date | null): Trigger =>
  ({ contextKind: 'conversation', contextId: 'teams:19:abc', createdAt: new Date(T0.getTime() - 60_000), lastFiredAt }) as unknown as Trigger;

describe('new activity since the last firing', () => {
  it('a message at the instant the last chain started is news', async () => {
    assert.equal(await checksWith(T0).newActivity(trigger(T0), OCC), true);
  });
  it('a message before it is not', async () => {
    assert.equal(await checksWith(new Date(T0.getTime() - 1)).newActivity(trigger(T0), OCC), false);
  });
  it('no firing yet: counted from creation', async () => {
    assert.equal(await checksWith(T0).newActivity(trigger(null), OCC), true);
  });
  it('no activity at all: nothing new', async () => {
    assert.equal(await checksWith(undefined).newActivity(trigger(T0), OCC), false);
  });
});

describe('a bot\'s own post is no activity', () => {
  const rig = () => {
    const noted: string[] = [];
    const store = {
      noteActivity: async (kind: string, contextId: string) => {
        noted.push(`${kind}:${contextId}`);
      },
      listHooks: async () => [],
    } as unknown as TriggerStore;
    const service = new TriggerService({
      store,
      limits: DEFAULT_TRIGGER_LIMITS,
      eventSources: () => [],
      checkDataAction: () => undefined,
      targetAllowed: () => true,
      now: () => T0,
    });
    return { noted, service };
  };

  it('a person\'s message is booked', async () => {
    const { noted, service } = rig();
    await service.onEvent(
      'conversation.message.created',
      { channelType: 'teams', conversationId: '19:abc', authorId: '29:person', receivedByChannelKey: '28:bot' },
      'm1',
    );
    assert.deepEqual(noted, ['conversation:teams:19:abc', 'meeting:teams:19:abc']);
  });

  it('the receiving bot\'s own post is not', async () => {
    const { noted, service } = rig();
    await service.onEvent(
      'conversation.message.created',
      { channelType: 'teams', conversationId: '19:abc', authorId: '28:bot', receivedByChannelKey: '28:bot' },
      'm2',
    );
    assert.deepEqual(noted, []);
  });
});
