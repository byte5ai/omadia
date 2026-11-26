/**
 * #1762 follow-up (ADR-0184) — `POST /api/v1/admin/chats/assign-orphans`
 * gives owner-less legacy web chats to one account: dry run counts, the real
 * run writes its audit row first, never touches an owned chat, and is
 * idempotent. The account then lists the chats through the chat routes.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore, type ChatSession } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import type { UserRecord } from '../src/auth/userStore.js';
import { createAdminChatsRouter } from '../src/routes/adminChats.js';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const MARCEL_ID = '11111111-1111-4111-8111-111111111111';
const MARCEL_SUB = 'entra-oid-marcel';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_UID = '33333333-3333-4333-8333-333333333333';

function user(id: string, providerUserId: string, status: 'active' | 'disabled' = 'active'): UserRecord {
  return {
    id,
    email: `${id}@example.com`,
    provider: 'entra',
    providerUserId,
    displayName: id,
    role: 'admin',
    status,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastLoginAt: null,
    sessionVersion: 0,
  };
}

function chat(id: string, ownerUserId?: string): ChatSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: 'm1', role: 'user', content: `secret ${id}`, startedAt: 1 }],
    ...(ownerUserId ? { ownerUserId } : {}),
  };
}

describe('#1762 — admin: assign owner-less chats', () => {
  let server: Server;
  let base: string;
  let store: ChatSessionStore;
  let audits: AuditEntryInput[];
  let auditFails: boolean;
  const users = new Map<string, UserRecord>([
    [MARCEL_ID, user(MARCEL_ID, MARCEL_SUB)],
    [OTHER_ID, user(OTHER_ID, 'other-sub', 'disabled')],
  ]);

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const sub = req.header('x-test-sub');
      (req as unknown as { session: unknown }).session = sub
        ? { sub, uid: ADMIN_UID, email: 'admin@example.com' }
        : { uid: ADMIN_UID, email: 'admin@example.com' };
      next();
    });
    app.use(
      '/api/v1/admin/chats',
      createAdminChatsRouter({
        getStore: () => store,
        findUser: (id) => Promise.resolve(users.get(id) ?? null),
        audit: {
          record: (entry) => {
            if (auditFails) return Promise.reject(new Error('db down'));
            audits.push(entry);
            return Promise.resolve();
          },
        },
      }),
    );
    // Several accounts: no sole-account legacy owner.
    app.use('/api/chat', createChatSessionsRouter({ getStore: () => store, legacyOwner: () => Promise.resolve(undefined) }));
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(async () => {
    store = new ChatSessionStore(new InMemoryMemoryStore());
    audits = [];
    auditFails = false;
    await store.save(chat('old-1'));
    await store.save(chat('old-2'));
    await store.save(chat('owned', 'someone-else'));
  });

  const assign = (body: unknown) =>
    fetch(`${base}/api/v1/admin/chats/assign-orphans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const listAs = async (sub: string): Promise<string[]> =>
    (
      (await (await fetch(`${base}/api/chat/sessions`, { headers: { 'x-test-sub': sub } })).json()) as {
        sessions: { id: string }[];
      }
    ).sessions
      .map((s) => s.id)
      .sort();

  it('a dry run counts and changes nothing', async () => {
    const res = await assign({ userId: MARCEL_ID, dryRun: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { dryRun: true, wouldAssign: 2, unreadable: 0 });
    assert.equal((await store.get('old-1'))?.ownerUserId, undefined);
    assert.equal(audits.length, 0);
    assert.deepEqual(await listAs(MARCEL_SUB), []);
  });

  it('assigns only owner-less chats, audits first with the count, and is idempotent', async () => {
    const res = await assign({ userId: MARCEL_ID });
    assert.deepEqual(await res.json(), { dryRun: false, assigned: 2, unreadable: 0 });
    assert.equal((await store.get('owned'))?.ownerUserId, 'someone-else');
    assert.deepEqual(await listAs(MARCEL_SUB), ['old-1', 'old-2']);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, 'chat.assign_orphans');
    assert.equal(audits[0]!.target, `user:${MARCEL_ID}`);
    assert.deepEqual(audits[0]!.actor, { id: ADMIN_UID, email: 'admin@example.com' });
    assert.deepEqual(audits[0]!.after, { owner: MARCEL_ID, count: 2 });

    const again = await assign({ userId: MARCEL_ID });
    assert.deepEqual(await again.json(), { dryRun: false, assigned: 0, unreadable: 0 });
  });

  it('changes nothing when the audit row cannot be written', async () => {
    auditFails = true;
    const res = await assign({ userId: MARCEL_ID });
    assert.equal(res.status, 500);
    assert.equal((await store.get('old-1'))?.ownerUserId, undefined);
  });

  it('refuses an unknown or disabled account and a malformed body', async () => {
    assert.equal((await assign({ userId: '44444444-4444-4444-8444-444444444444' })).status, 404);
    assert.equal((await assign({ userId: OTHER_ID })).status, 409);
    assert.equal((await assign({ userId: 'not-a-uuid' })).status, 400);
    assert.equal((await store.get('old-1'))?.ownerUserId, undefined);
  });

  it('counts an unreadable file apart and leaves it', async () => {
    const memory = (store as unknown as { store: InMemoryMemoryStore }).store;
    await memory.writeFile('/memories/chat-sessions/broken.json', '{not json');
    const res = await assign({ userId: MARCEL_ID });
    assert.deepEqual(await res.json(), { dryRun: false, assigned: 2, unreadable: 1 });
  });
});
