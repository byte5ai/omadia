/**
 * #2361 (ADR-0330) — a new web chat's id must be lower case. The transcript
 * directory and the graph key fold the id to `[a-z0-9_-]`, so a chat `ABC`
 * would share the partition of another chat `abc`. Existing chats with an
 * upper-case id stay usable.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import type { Request } from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import {
  ChatSessionStore,
  NonCanonicalSessionIdError,
  isCanonicalChatSessionId,
  type ChatSession,
} from '@omadia/orchestrator';

import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { chatSessionRefusal, chatSessionUse } from '../src/routes/chatSessionAccess.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const T0 = 1_700_000_000_000;
const ACCOUNT = 'account-1';

function chat(id: string, ownerUserId?: string): ChatSession {
  return {
    id,
    title: 't',
    createdAt: T0,
    updatedAt: T0,
    messages: [],
    ...(ownerUserId ? { ownerUserId } : {}),
  };
}

const reqOf = (sub: string): Request => ({ session: { sub } }) as unknown as Request;

describe('#2361 · isCanonicalChatSessionId', () => {
  it('accepts the ids the web chat mints and refuses upper case', () => {
    assert.equal(isCanonicalChatSessionId('0f8e2c1a-1b2c-4d5e-8f90-123456789abc'), true);
    assert.equal(isCanonicalChatSessionId('id-mabc12-x9y8z7'), true);
    assert.equal(isCanonicalChatSessionId('tab_1-x'), true);
    assert.equal(isCanonicalChatSessionId('0F8E2C1A-1B2C-4D5E-8F90-123456789ABC'), false);
    assert.equal(isCanonicalChatSessionId('Tab-1'), false);
    assert.equal(isCanonicalChatSessionId('a.b'), false);
  });
});

describe('#2361 · ChatSessionStore.saveFromClient', () => {
  it('refuses to create a chat with an upper-case id', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await assert.rejects(
      store.saveFromClient(chat('Tab-1'), { viewer: ACCOUNT, legacyOwner: undefined }),
      NonCanonicalSessionIdError,
    );
    assert.equal(await store.get('Tab-1'), null);
  });

  it('keeps writing an existing chat whose id has upper case', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(chat('Legacy-1', ACCOUNT));
    const stored = await store.saveFromClient(
      { ...chat('Legacy-1'), title: 'renamed' },
      { viewer: ACCOUNT, legacyOwner: undefined },
    );
    assert.equal(stored.title, 'renamed');
  });
});

describe('#2361 · chatSessionUse (turns, steering, uploads)', () => {
  it('refuses a new upper-case id and allows a new lower-case one', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    assert.equal(await chatSessionUse(reqOf(ACCOUNT), store, 'ABC', undefined), 'non_canonical_id');
    assert.equal(await chatSessionUse(reqOf(ACCOUNT), store, 'abc', undefined), 'ok');
    assert.equal(await chatSessionUse(reqOf(ACCOUNT), undefined, 'ABC', undefined), 'non_canonical_id');
  });

  it('lets the owner keep using a stored upper-case chat and hides it from others', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(chat('Legacy-1', ACCOUNT));
    assert.equal(await chatSessionUse(reqOf(ACCOUNT), store, 'Legacy-1', undefined), 'ok');
    assert.equal(await chatSessionUse(reqOf('account-2'), store, 'Legacy-1', undefined), 'not_found');
  });

  it('maps the refusals to 400 and 404', () => {
    assert.equal(chatSessionRefusal('non_canonical_id', 'ABC').status, 400);
    assert.equal(chatSessionRefusal('non_canonical_id', 'ABC').error, 'non_canonical_id');
    assert.equal(chatSessionRefusal('not_found', 'ABC').status, 404);
  });
});

describe('#2361 · PUT /sessions/:id', () => {
  let server: Server;
  let base: string;
  let store: ChatSessionStore;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { sub: ACCOUNT };
      next();
    });
    app.use('/api/chat', createChatSessionsRouter({ getStore: () => store, legacyOwner: () => Promise.resolve(undefined) }));
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    store = new ChatSessionStore(new InMemoryMemoryStore());
  });

  const put = (session: ChatSession): Promise<Response> =>
    fetch(`${base}/sessions/${session.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    });

  it('answers 400 non_canonical_id for a new upper-case chat', async () => {
    const res = await put(chat('Tab-1'));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'non_canonical_id');
  });

  it('stores a new lower-case chat and updates an existing upper-case one', async () => {
    assert.equal((await put(chat('tab-1'))).status, 200);
    await store.save(chat('Legacy-1', ACCOUNT));
    assert.equal((await put(chat('Legacy-1'))).status, 200);
  });
});
