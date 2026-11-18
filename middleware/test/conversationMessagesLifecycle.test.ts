/**
 * 'conversationMessages@1' (#2043) — the life of a subscription outside the
 * engine's own subscribe/unsubscribe: the kernel ending it, other machines,
 * the per-plugin service, CoreApi and retention. Storing and reading are in
 * `conversationMessagesHub.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';


import { createCoreApi } from '../src/channels/coreApi.js';
import { startConversationMessagePurge } from '../src/channels/conversationMessages/purgeJob.js';
import { createConversationMessagesService } from '../src/channels/conversationMessages/service.js';
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
  scopeOf,
} from './_helpers/conversationMessagesFixture.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('conversationMessages: the kernel ends a subscription whose ground is gone', () => {
  it('engine removed with live subscriptions: the gate closes, nothing more is stored, the other agent is untouched', async () => {
    const store = new InMemoryConversationMessageStore();
    const f = hubFixture(store);
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.subscribe(scopeOf('nora', '19:other@thread.v2'), ENGINE);
    await f.hub.ingest(messageEvent());
    assert.deepEqual(await f.hub.reconcile(), [], 'nothing lost its ground yet');

    f.lostGround.set('mara', "plugin '@omadia/agent-facilitator' is no longer the facilitation engine of this instance");
    const ended = await f.hub.reconcile();
    assert.deepEqual(ended.map((e) => [e.subscription.agentSlug, e.reason]), [
      ['mara', "plugin '@omadia/agent-facilitator' is no longer the facilitation engine of this instance"],
    ]);
    // The mention gate applies again, so the agent is no longer silenced…
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
    assert.equal(f.hub.subscriptionFor(scopeOf('mara')), undefined);
    // …and nothing more is stored.
    assert.equal(await f.hub.ingest(messageEvent({ messageId: 'after' })), undefined);
    assert.deepEqual(await store.listActiveSubscriptions().then((l) => l.map((x) => x.agentSlug)), ['nora']);
    assert.equal(f.hub.isSubscribed('teams', '19:other@thread.v2', NORA_KEY), true);
    assert.ok(f.logs.some((l) => /ended the subscription of 'mara'/.test(l)));
    assert.deepEqual(await f.hub.reconcile(), [], 'idempotent');
  });

  it('a ground check that throws ends nothing', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    f.lostGround.get = () => {
      throw new Error('config store unreachable');
    };
    assert.deepEqual(await f.hub.reconcile(), []);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true);
  });

  it('a subscription row that vanished (agent deleted) closes the gate on the next event instead of failing forever', async () => {
    const store = new InMemoryConversationMessageStore();
    const f = hubFixture(store);
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
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
    const subscribing = f.hub.subscribe(scopeOf('mara'), ENGINE);
    release();
    await Promise.all([refreshing, subscribing]);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true, 'the stale snapshot did not win');

    store.listActiveSubscriptions = list;
    await Promise.all([f.hub.unsubscribe(scopeOf('mara'), ENGINE), f.hub.refresh()]);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false, 'not resurrected');
  });

  it('a subscribe on another machine is picked up by refresh', async () => {
    const store = new InMemoryConversationMessageStore();
    const here = hubFixture(store);
    const there = hubFixture(store);
    await there.hub.subscribe(scopeOf('mara'), ENGINE);
    assert.equal(here.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
    await here.hub.refresh();
    assert.equal(here.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true);
    await there.hub.unsubscribe(scopeOf('mara'), ENGINE);
    await here.hub.refresh();
    assert.equal(here.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
  });
});

describe('conversationMessages: plugin-facing service', () => {
  it('live delivery is decided at delivery, in both directions', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    let engine = false;
    const service = createConversationMessagesService({ hub: f.hub, callerPluginId: ENGINE, isEngine: () => engine });
    const seen: string[] = [];
    // Registered BEFORE the plugin is the bound engine (activation order).
    const dispose = service.onMessage('mara', (r) => void seen.push(r.messageId));
    engine = true;
    await service.subscribe(scopeOf('mara'));
    f.hub.emit(messageEvent({ messageId: 'a' }));
    await flush();
    await flush();
    assert.deepEqual(seen, ['a'], 'a handler registered early starts receiving once the plugin is the engine');
    engine = false; // replaced or deactivated
    f.hub.emit(messageEvent({ messageId: 'b' }));
    await flush();
    await flush();
    assert.deepEqual(seen, ['a'], 'and stops at once when it is not');
    engine = true;
    f.hub.emit(messageEvent({ messageId: 'c' }));
    await flush();
    await flush();
    assert.deepEqual(seen, ['a', 'c']);
    dispose();
  });

  it('answers only the facilitation engine', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    let engine = true;
    const forEngine = createConversationMessagesService({ hub: f.hub, callerPluginId: ENGINE, isEngine: () => engine });
    const forOther = createConversationMessagesService({ hub: f.hub, callerPluginId: '@acme/crm', isEngine: () => false });
    const refused = await forOther.subscribe(scopeOf('mara'));
    assert.equal(refused.outcome === 'refused' && refused.code, 'unavailable');
    assert.match(refused.outcome === 'refused' ? refused.message : '', /only the facilitation engine plugin/);

    assert.deepEqual(await forEngine.subscribe(scopeOf('mara')), { outcome: 'subscribed' });
    await f.hub.ingest(messageEvent());
    assert.equal((await forEngine.getEvent(scopeOf('mara'), 'm1'))?.author.id, 'AAD-Anna');
    assert.equal(await forOther.getEvent(scopeOf('mara'), 'm1'), undefined);
    assert.deepEqual(await forOther.listSince(scopeOf('mara')), { events: [] });
    await forOther.unsubscribe(scopeOf('mara'));
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true);

    // The plugin stops being the engine (uninstalled, replaced): nothing more.
    engine = false;
    assert.equal(await forEngine.getEvent(scopeOf('mara'), 'm1'), undefined);
    engine = true;
    await forEngine.unsubscribe(scopeOf('mara'));
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
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
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    assert.equal(api.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY.toLowerCase()), true);
    assert.equal(api.isAllMessagesSubscribed!(undefined as never, CONVERSATION, MARA_KEY), false, 'never throws');
    api.emitConversationMessage!(messageEvent());
    await flush();
    assert.equal((await f.hub.listSince(scopeOf('mara'), ENGINE)).events.length, 1);
    const throwing = createCoreApi({
      ...baseOptions,
      conversationMessages: {
        emit: () => undefined,
        isSubscribed: () => {
          throw new Error('boom');
        },
      },
    });
    assert.equal(throwing.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY), false);
  });

  it('purges only after the subscription ended plus the grace period, and by age', async () => {
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
      await f.hub.subscribe(scopeOf('mara'), ENGINE);
      await f.hub.ingest(messageEvent());
      now += 20 * 24 * HOUR; // a long facilitation: still subscribed, nothing goes
      await job.tick();
      assert.equal((await f.hub.listSince(scopeOf('mara'), ENGINE)).events.length, 1);

      await f.hub.ingest(messageEvent({ messageId: 'm2' }));
      now += 11 * 24 * HOUR; // the first event is now older than the maximum age
      await job.tick();
      assert.deepEqual(
        (await f.hub.listSince(scopeOf('mara'), ENGINE)).events.map((e) => e.messageId),
        ['m2'],
      );

      await f.hub.unsubscribe(scopeOf('mara'), ENGINE);
      now += 5 * HOUR; // inside the grace period
      assert.deepEqual(await store.purge({ endedBefore: new Date(now - 6 * HOUR) }), { events: 0, subscriptions: 0 });
      now += 2 * HOUR;
      await job.tick();
      assert.ok(f.logs.some((l) => /purged 1 event\(s\) of 1 ended subscription\(s\)/.test(l)));
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
