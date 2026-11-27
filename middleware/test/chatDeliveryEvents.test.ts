/**
 * #2354 (ADR-0321) — a routine delivery into a web chat reaches the open chat
 * live: the sender signals the chat's delivery streams, which carry a signal
 * only (never the text), open only for the chat's owner and end with the
 * session that opened them.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore } from '@omadia/orchestrator';
import type { ChatSession } from '@omadia/orchestrator';
import type { SemanticAnswer } from '@omadia/channel-sdk';

import { ChatDeliveryBus, type ChatDeliveryEvent } from '../src/routes/chatDeliveryEvents.js';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import {
  createWebChatProactiveSender,
  webChatConversationRef,
} from '../src/plugins/routines/webChatProactiveSender.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ANNA = 'account-anna';
const BEN = 'account-ben';
const T0 = 1_700_000_000_000;
const FAR_FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;

function chat(id: string, owner: string): ChatSession {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: T0,
    updatedAt: T0,
    ownerUserId: owner,
    messages: [{ id: 'u1', role: 'user', content: 'report please', startedAt: T0 }],
  };
}

const sessions = {
  evaluate: () => Promise.resolve({ ok: true } as never),
  revocations: { onRevoked: () => () => undefined },
};

describe('#2354 — ChatDeliveryBus', () => {
  it('fans a delivery out to the chat’s listeners only, and unsubscribes', () => {
    const bus = new ChatDeliveryBus();
    const got: ChatDeliveryEvent[] = [];
    const off = bus.subscribe('c1', (e) => got.push(e));
    bus.subscribe('c2', () => assert.fail('another chat was told'));
    bus.publish({ type: 'delivery', sessionId: 'c1', deliveredAt: 1 });
    assert.deepEqual(got, [{ type: 'delivery', sessionId: 'c1', deliveredAt: 1 }]);
    off();
    assert.equal(bus.listenerCount('c1'), 0);
    bus.publish({ type: 'delivery', sessionId: 'c1', deliveredAt: 2 });
    assert.equal(got.length, 1);
  });

  it('a throwing listener does not stop the others or reach the publisher', () => {
    const bus = new ChatDeliveryBus();
    let reached = false;
    bus.subscribe('c1', () => {
      throw new Error('boom');
    });
    bus.subscribe('c1', () => {
      reached = true;
    });
    bus.publish({ type: 'delivery', sessionId: 'c1', deliveredAt: 1 });
    assert.equal(reached, true);
  });
});

describe('#2354 — web sender signals a stored delivery', () => {
  const REF = webChatConversationRef('scope', 'c1');
  const answer = (text: string): SemanticAnswer => ({ text }) as SemanticAnswer;

  it('signals after the append, with the delivery time', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(chat('c1', ANNA));
    const signals: Array<[string, number]> = [];
    const sender = createWebChatProactiveSender({
      getStore: () => store,
      now: () => 42,
      onDelivered: (id, at) => signals.push([id, at]),
    });
    await sender.send({ conversationRef: REF, message: answer('Report') } as never);
    assert.deepEqual(signals, [['c1', 42]]);
  });

  it('no signal for a quiet run or a gone chat; a failing signal keeps the delivery', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    const signals: string[] = [];
    const quiet = createWebChatProactiveSender({
      getStore: () => store,
      onDelivered: (id) => signals.push(id),
    });
    await quiet.send({ conversationRef: REF, message: answer('NO_REPLY') } as never);
    await assert.rejects(quiet.send({ conversationRef: REF, message: answer('Report') } as never));
    assert.deepEqual(signals, []);

    await store.save(chat('c1', ANNA));
    const throwing = createWebChatProactiveSender({
      getStore: () => store,
      warn: () => undefined,
      onDelivered: () => {
        throw new Error('bus down');
      },
    });
    await throwing.send({ conversationRef: REF, message: answer('Report') } as never);
    const stored = await store.get('c1');
    assert.equal(stored?.messages.at(-1)?.content, 'Report');
  });
});

describe('#2354 — GET /api/chat/sessions/:id/events', () => {
  let server: Server;
  let base: string;
  let bareBase: string;
  const bus = new ChatDeliveryBus();
  const store = new ChatSessionStore(new InMemoryMemoryStore());

  before(async () => {
    await store.save(chat('c1', ANNA));
    const app = express();
    app.use((req, _res, next) => {
      const sub = req.header('x-test-account');
      (req as unknown as { session: unknown }).session = sub
        ? { sub, provider: 'local', exp: FAR_FUTURE_EXP }
        : undefined;
      (req as unknown as { cookies: unknown }).cookies = sub ? { omadia_session: 'tok' } : {};
      next();
    });
    app.use(
      '/api/chat',
      createChatSessionsRouter({
        getStore: () => store,
        deliveries: { bus, sessions, heartbeatMs: 0 },
      }),
    );
    app.use('/bare/chat', createChatSessionsRouter({ getStore: () => store }));
    server = await listenLoopback(app);
    const root = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    base = `${root}/api/chat`;
    bareBase = `${root}/bare/chat`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('streams a delivery signal to the owner, without the text', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/sessions/c1/events`, {
      headers: { 'x-test-account': ANNA },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': connected')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    assert.equal(bus.listenerCount('c1'), 1);
    bus.publish({ type: 'delivery', sessionId: 'c1', deliveredAt: 7 });
    while (!text.includes('event: delivery')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    assert.match(text, /data: \{"type":"delivery","sessionId":"c1","deliveredAt":7\}/);
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
    for (let i = 0; i < 50 && bus.listenerCount('c1') > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(bus.listenerCount('c1'), 0, 'closing the stream unsubscribes');
  });

  it('another account’s or a missing chat answers 404 and opens nothing', async () => {
    for (const [account, id] of [
      [BEN, 'c1'],
      [ANNA, 'missing'],
    ] as const) {
      const res = await fetch(`${base}/sessions/${id}/events`, {
        headers: { 'x-test-account': account },
      });
      assert.equal(res.status, 404);
      await res.body?.cancel();
    }
    assert.equal(bus.listenerCount('c1'), 0);
  });

  it('without a session the stream is refused; without the feature it is 404', async () => {
    const anon = await fetch(`${base}/sessions/c1/events`);
    assert.equal(anon.status, 404, 'no viewer → not the caller’s chat');
    await anon.body?.cancel();
    const bare = await fetch(`${bareBase}/sessions/c1/events`, {
      headers: { 'x-test-account': ANNA },
    });
    assert.equal(bare.status, 404);
    await bare.body?.cancel();
  });
});
