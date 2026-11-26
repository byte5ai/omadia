/**
 * #1762 (ADR-0180) — a web chat belongs to the account that created it.
 *
 * Two accounts on one instance: each lists, reads, writes, resets and deletes
 * only its own chats; another account's chat answers 404 like a missing one,
 * and a turn or steer into it is refused the same way. Chats written before
 * owners existed belong to the instance's only account, or to nobody.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore } from '@omadia/orchestrator';
import type { ChatAgent, ChatSession, ChatTurnResult } from '@omadia/orchestrator';

import { createChatRouter } from '../src/routes/chat.js';
import { soleAccountLegacyOwner } from '../src/routes/chatSessionAccess.js';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import { routeTurnFrom } from './_helpers/webRouteTurn.js';

const ANNA = 'account-anna';
const BEN = 'account-ben';
const T0 = 1_700_000_000_000;

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: T0,
    updatedAt: T0,
    messages: [{ id: 'u1', role: 'user', content: `secret of ${id}`, startedAt: T0 }],
    ...extra,
  };
}

const agent: ChatAgent = {
  chat: () => Promise.resolve({ kind: 'message', text: 'ok' } as unknown as ChatTurnResult),
  chatStream: () => {
    throw new Error('not used');
  },
} as unknown as ChatAgent;

describe('#1762 — web chats are owned by the account that created them', () => {
  let server: Server;
  let base: string;
  let store: ChatSessionStore;
  let legacy: string | undefined;

  before(async () => {
    const app = express();
    app.use(express.json());
    // The signed-in account comes from the test header (requireAuth's `sub`).
    app.use((req, _res, next) => {
      const sub = req.header('x-test-account');
      (req as unknown as { session: unknown }).session = sub ? { sub } : undefined;
      next();
    });
    const legacyOwner = (): Promise<string | undefined> => Promise.resolve(legacy);
    app.use('/api/chat', createChatSessionsRouter({ getStore: () => store, legacyOwner }));
    app.use(
      '/api',
      createChatRouter({
        getChatSessionStore: () => store,
        legacyChatOwner: legacyOwner,
        routeTurn: routeTurnFrom(
          () => agent,
          () => 'general',
        ),
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    store = new ChatSessionStore(new InMemoryMemoryStore());
    legacy = undefined;
  });

  const call = (account: string | undefined, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(account ? { 'x-test-account': account } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const listIds = async (account: string): Promise<string[]> => {
    const res = await call(account, 'GET', '/sessions');
    return ((await res.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort();
  };

  it('stamps the creating account on the first PUT and lists the chat only for it', async () => {
    assert.equal((await call(ANNA, 'PUT', '/sessions/tab-a', chat('tab-a'))).status, 200);
    assert.equal((await call(BEN, 'PUT', '/sessions/tab-b', chat('tab-b'))).status, 200);
    assert.equal((await store.get('tab-a'))?.ownerUserId, ANNA);
    assert.deepEqual(await listIds(ANNA), ['tab-a']);
    assert.deepEqual(await listIds(BEN), ['tab-b']);
  });

  it('answers 404 for every route on another account’s chat and changes nothing', async () => {
    await call(ANNA, 'PUT', '/sessions/tab-a', chat('tab-a'));
    const before = JSON.stringify(await store.get('tab-a'));
    for (const [method, path, body] of [
      ['GET', '/sessions/tab-a'],
      ['PUT', '/sessions/tab-a', chat('tab-a', { messages: [] })],
      ['DELETE', '/sessions/tab-a'],
      ['POST', '/sessions/tab-a/reset'],
      ['POST', '/sessions/tab-a/re-snapshot'],
    ] as const) {
      const res = await call(BEN, method, path, body);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.doesNotMatch(await res.text(), /secret of/);
    }
    assert.equal(JSON.stringify(await store.get('tab-a')), before);
  });

  it('a body cannot claim or move the owner, and GET does not return it', async () => {
    await call(ANNA, 'PUT', '/sessions/tab-a', { ...chat('tab-a'), ownerUserId: BEN });
    assert.equal((await store.get('tab-a'))?.ownerUserId, ANNA);
    const got = (await (await call(ANNA, 'GET', '/sessions/tab-a')).json()) as Record<string, unknown>;
    assert.equal(got['ownerUserId'], undefined);
    assert.equal(got['id'], 'tab-a');
  });

  it('a request without an account saves nothing and lists nothing', async () => {
    await call(ANNA, 'PUT', '/sessions/tab-a', chat('tab-a'));
    assert.equal((await call(undefined, 'PUT', '/sessions/tab-x', chat('tab-x'))).status, 401);
    const res = await call(undefined, 'GET', '/sessions');
    assert.deepEqual(((await res.json()) as { sessions: unknown[] }).sessions, []);
  });

  it('legacy chats (no owner) belong to the only account, or to nobody', async () => {
    await store.save(chat('old-1'));
    assert.deepEqual(await listIds(ANNA), [], 'two accounts: hidden from everyone');
    assert.equal((await call(ANNA, 'GET', '/sessions/old-1')).status, 404);

    legacy = ANNA;
    assert.deepEqual(await listIds(ANNA), ['old-1']);
    assert.deepEqual(await listIds(BEN), []);
    // Writing it stamps the resolved owner, so it stays Anna's later.
    assert.equal((await call(ANNA, 'PUT', '/sessions/old-1', chat('old-1'))).status, 200);
    legacy = undefined;
    assert.deepEqual(await listIds(ANNA), ['old-1']);
  });

  it('a chat turn or steer into another account’s chat answers 404', async () => {
    await call(ANNA, 'PUT', '/sessions/tab-a', chat('tab-a'));
    const turn = await call(BEN, 'POST', '', { message: 'what did Anna say?', sessionId: 'tab-a' });
    assert.equal(turn.status, 404);
    const steer = await call(BEN, 'POST', '/steer', { message: 'stop', sessionId: 'tab-a' });
    assert.equal(steer.status, 404);
    // The owner's own turn runs.
    const own = await call(ANNA, 'POST', '', { message: 'hi', sessionId: 'tab-a' });
    assert.equal(own.status, 200);
  });
});

describe('#1762 — soleAccountLegacyOwner', () => {
  it('is the account when there is exactly one, else nobody; failures hide', async () => {
    let accounts: { id: string }[] = [{ id: 'a' }];
    let clock = 0;
    const owner = soleAccountLegacyOwner(
      () => Promise.resolve(accounts),
      () => clock,
    );
    assert.equal(await owner(), 'a');
    accounts = [{ id: 'a' }, { id: 'b' }];
    assert.equal(await owner(), 'a', 'cached for a short while');
    clock += 60_000;
    assert.equal(await owner(), undefined);
    const failing = soleAccountLegacyOwner(() => Promise.reject(new Error('db down')));
    assert.equal(await failing(), undefined);
  });
});
