/**
 * 'conversationMessages@2' (#2043, #2089) — the life of a subscription
 * outside the plugin's own subscribe: the kernel ending it, other machines,
 * CoreApi and retention. Storing and reading are in
 * `conversationMessagesHub.test.ts`; what a process's scopes and reservation
 * do to it is in `processConversationMessages.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';


import { createCoreApi } from '../src/channels/coreApi.js';
import { startConversationMessagePurge } from '../src/channels/conversationMessages/purgeJob.js';
import {
  InMemoryConversationMessageStore,
} from '../src/channels/conversationMessages/store.js';
import {
  createBotPresenceCheck,
  principalOfChannelUser,
} from '../src/channels/conversationMessages/wiring.js';
import {
  CONVERSATION,
  ENGINE,
  hubFixture,
  MARA_KEY,
  messageEvent,
  NORA_KEY,
  processOf,
  readAll,
} from './_helpers/conversationMessagesFixture.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const MARA = processOf('mara');
const INACTIVE = 'the plugin that subscribed is inactive';

describe('conversationMessages: the kernel ends a subscription whose ground is gone', () => {
  it('ground lost with live subscriptions: the gate closes, nothing more is stored, the other agent is untouched', async () => {
    const store = new InMemoryConversationMessageStore();
    const f = hubFixture(store);
    await readAll(f, 'mara');
    await readAll(f, 'nora', '19:other@thread.v2');
    await f.hub.ingest(messageEvent());
    assert.deepEqual(await f.hub.reconcile(), [], 'nothing lost its ground yet');

    f.lostGround.set('mara', INACTIVE);
    const ended = await f.hub.reconcile();
    assert.deepEqual(ended.map((e) => [e.subscription.agentSlug, e.subscription.processId, e.reason]), [
      ['mara', MARA.processId, INACTIVE],
    ]);
    // The mention gate applies again, so the agent is no longer silenced…
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
    assert.equal(f.hub.modeOfProcess(MARA, ENGINE), undefined);
    assert.deepEqual((await f.hub.listProcessEventsSince(MARA, ENGINE)).events, [], 'reads end with it');
    // …and nothing more is stored.
    assert.equal(await f.hub.ingest(messageEvent({ messageId: 'after' })), undefined);
    assert.deepEqual(await store.listActiveSubscriptions().then((l) => l.map((x) => x.agentSlug)), ['nora']);
    assert.equal(f.hub.isSubscribed('teams', '19:other@thread.v2', NORA_KEY), true);
    assert.ok(f.logs.some((l) => /ended the subscription of 'mara'/.test(l)));
    assert.deepEqual(await f.hub.reconcile(), [], 'idempotent');
  });

  it('a ground check that throws ends nothing', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await readAll(f, 'mara');
    f.lostGround.get = () => {
      throw new Error('config store unreachable');
    };
    assert.deepEqual(await f.hub.reconcile(), []);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true);
  });

  it('a subscription row that vanished (agent deleted) closes the gate on the next event instead of failing forever', async () => {
    const store = new InMemoryConversationMessageStore();
    const f = hubFixture(store);
    await readAll(f, 'mara');
    // The cascade removed the row on another connection; this cache still has it.
    store.insertEvent = () => Promise.reject(Object.assign(new Error('violates foreign key constraint'), { code: '23503' }));
    assert.equal(await f.hub.ingest(messageEvent()), undefined);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
    assert.ok(f.logs.some((l) => /no longer exists; the gate is closed/.test(l)));
  });

  it('a refresh never overwrites a subscribe that ran while it was reading, nor resurrects one being ended', async () => {
    const store = new InMemoryConversationMessageStore();
    const f = hubFixture(store);
    // The refresh reads the table BEFORE the subscribe below writes to it,
    // and returns only afterwards.
    const list = store.listActiveSubscriptions.bind(store);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    store.listActiveSubscriptions = async () => {
      const snapshot = await list();
      await held;
      return snapshot;
    };
    const refreshing = f.hub.refresh();
    const subscribing = readAll(f, 'mara');
    release();
    await Promise.all([refreshing, subscribing]);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true, 'the stale snapshot did not win');

    store.listActiveSubscriptions = list;
    await Promise.all([f.hub.endAllOf('mara', 'agent disabled'), f.hub.refresh()]);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false, 'not resurrected');
  });

  it('a subscribe on another machine is picked up by refresh, and so are a changed mode and its end', async () => {
    const store = new InMemoryConversationMessageStore();
    const here = hubFixture(store);
    const there = hubFixture(store);
    await readAll(there, 'mara');
    assert.equal(here.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
    await here.hub.refresh();
    assert.equal(here.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true);
    // The process there reads the stored events here, without subscribing again.
    await there.hub.ingest(messageEvent());
    assert.equal((await here.hub.listProcessEventsSince(MARA, ENGINE)).events.length, 1);
    await there.hub.subscribeProcess(MARA, 'addressed', ENGINE);
    await here.hub.refresh();
    assert.equal(here.hub.deliveryMode('teams', CONVERSATION, MARA_KEY), 'addressed');
    await there.hub.endAllOf('mara', 'agent disabled');
    await here.hub.refresh();
    assert.equal(here.hub.deliveryMode('teams', CONVERSATION, MARA_KEY), 'none');
  });
});

describe('conversationMessages: CoreApi and retention', () => {
  const baseOptions = { dispatcher: {} as never, routes: {} as never };

  it('CoreApi exposes emit and the synchronous lookup only when wired', async () => {
    assert.equal(createCoreApi(baseOptions).emitConversationMessage, undefined);
    assert.equal(createCoreApi(baseOptions).isAllMessagesSubscribed, undefined);
    const f = hubFixture(new InMemoryConversationMessageStore());
    const api = createCoreApi({ ...baseOptions, conversationMessages: f.hub });
    assert.equal(api.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY), false);
    await readAll(f, 'mara');
    assert.equal(api.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY.toLowerCase()), true);
    assert.equal(api.conversationDelivery!('teams', CONVERSATION, MARA_KEY), 'all');
    assert.equal(api.isAllMessagesSubscribed!(undefined as never, CONVERSATION, MARA_KEY), false, 'never throws');
    api.emitConversationMessage!(messageEvent());
    await flush();
    assert.equal((await f.hub.listProcessEventsSince(MARA, ENGINE)).events.length, 1);
    const throwing = createCoreApi({
      ...baseOptions,
      conversationMessages: {
        emit: () => undefined,
        isSubscribed: () => {
          throw new Error('boom');
        },
        deliveryMode: () => {
          throw new Error('boom');
        },
      },
    });
    assert.equal(throwing.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY), false);
    assert.equal(throwing.conversationDelivery!('teams', CONVERSATION, MARA_KEY), 'none');
  });

  it('purges only after the subscription ended plus the grace period, not by age while its process runs', async () => {
    let now = Date.parse('2026-11-18T09:00:00.000Z');
    const store = new InMemoryConversationMessageStore(() => new Date(now));
    const f = hubFixture(store);
    const HOUR = 60 * 60 * 1000;
    const job = startConversationMessagePurge(store, {
      graceMs: 6 * HOUR,
      maxAgeDays: 30,
      intervalMs: 3_600_000,
      now: () => now,
      log: (m) => f.logs.push(m),
    });
    try {
      await readAll(f, 'mara');
      await f.hub.ingest(messageEvent());
      now += 20 * 24 * HOUR; // a long facilitation: still subscribed, nothing goes
      await job.tick();
      assert.equal((await f.hub.listProcessEventsSince(MARA, ENGINE)).events.length, 1);

      // While its process runs, an event does not go by age either: the
      // process's scopes bound how long it lives, not the calendar.
      await f.hub.ingest(messageEvent({ messageId: 'm2' }));
      now += 11 * 24 * HOUR; // the first event is now older than the maximum age
      await job.tick();
      assert.deepEqual(
        (await f.hub.listProcessEventsSince(MARA, ENGINE)).events.map((e) => e.messageId),
        ['m1', 'm2'],
      );

      await f.hub.endAllOf('mara', 'agent disabled');
      now += 5 * HOUR; // inside the grace period
      assert.deepEqual(await store.purge({ endedBefore: new Date(now - 6 * HOUR) }), { events: 0, subscriptions: 0 });
      now += 2 * HOUR;
      await job.tick();
      assert.ok(f.logs.some((l) => /purged 2 event\(s\) of 1 ended subscription\(s\)/.test(l)));
    } finally {
      job.stop();
    }
  });

  it('presence: per-bot references decide, the invite index is the fallback', async () => {
    const invites = { get: (_t: string, c: string) => (c === 'invited' ? ({} as never) : undefined) };
    const withRefs = createBotPresenceCheck({
      invites,
      botPresence: { botAppIdsIn: (c) => Promise.resolve(c === 'empty' || c === 'invited' ? [] : ['aaaa-mara']) },
    });
    assert.equal(await withRefs('teams', 'chat', '28:AAAA-MARA'), true);
    assert.equal(await withRefs('teams', 'chat', '28:bbbb-nora'), false, 'another bot is there, this one is not');
    assert.equal(await withRefs('teams', 'empty', '28:aaaa-mara'), false);
    assert.equal(await withRefs('teams', 'invited', '28:aaaa-mara'), true, 'no references: invite index');
    assert.equal(await createBotPresenceCheck({ invites })('slack', 'invited', 'B1'), true);
    assert.equal(principalOfChannelUser({ id: 'AAD-Anna' }), 'user:aad-anna');
  });
});
