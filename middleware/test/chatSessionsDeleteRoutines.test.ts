/**
 * #1753 / #1757 — deleting a web chat pauses the routines that deliver into
 * it and removes its markdown transcripts; the close confirmation can name
 * those routines first.
 */
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import { purgeSessionTranscripts } from '../src/plugins/routines/sessionTranscripts.js';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

describe('#1753 / #1757 — deleting a web chat', () => {
  const memory = new InMemoryMemoryStore();
  const store = new ChatSessionStore(memory);
  const paused: string[] = [];
  const audited: AuditEntryInput[] = [];
  let server: import('node:http').Server;
  let base = '';

  before(async () => {
    await store.save({ id: '11111111-1111-4111-8111-111111111111', title: 't', createdAt: 1, updatedAt: 1, messages: [], ownerUserId: 'u-1' });
    await memory.createFile('/memories/sessions/11111111-1111-4111-8111-111111111111/2026-11-26.md', '# turn');
    await memory.createFile('/memories/sessions/22222222-2222-4222-8222-222222222222/2026-11-26.md', '# other chat');
    const app = express();
    app.use(express.json());
    // The session's `sub` owns chats (#1762); tests pick it per request.
    app.use((req, _res, next) => {
      (req as unknown as { session: { sub: string; uid: string; email: string } }).session = {
        sub: req.header('x-test-sub') ?? 'u-1',
        uid: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
        email: 'owner@example.test',
      };
      next();
    });
    app.use(
      '/api/chat',
      createChatSessionsRouter({
        getStore: () => store,
        purgeTranscripts: (scope) => purgeSessionTranscripts(memory, scope),
        routines: () => ({
          listForChat: (id) => Promise.resolve(id === '11111111-1111-4111-8111-111111111111' ? [{ id: 'r1', name: 'Morgenbericht' }] : []),
          pauseForChat: (id) => {
            paused.push(id);
            return Promise.resolve(id === '11111111-1111-4111-8111-111111111111' ? ['r1'] : []);
          },
        }),
        audit: () => ({
          record: (entry) => {
            audited.push(entry);
            return Promise.resolve();
          },
        }),
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('tells another account nothing about the chat\'s routines and pauses none', async () => {
    const other = { headers: { 'x-test-sub': 'u-2' } };
    assert.equal((await fetch(`${base}/api/chat/sessions/11111111-1111-4111-8111-111111111111/routines`, other)).status, 404);
    const res = await fetch(`${base}/api/chat/sessions/11111111-1111-4111-8111-111111111111`, { method: 'DELETE', ...other });
    assert.equal(res.status, 404);
    assert.deepEqual(paused, []);
    assert.deepEqual(audited, []);
  });

  it('pauses nothing for a chat that was never saved', async () => {
    const res = await fetch(`${base}/api/chat/sessions/22222222-2222-4222-8222-222222222222`, { method: 'DELETE' });
    assert.deepEqual(await res.json(), { ok: true, routinesPaused: 0 });
    assert.deepEqual(paused, []);
    assert.equal(await memory.fileExists('/memories/sessions/22222222-2222-4222-8222-222222222222/2026-11-26.md'), true);
  });

  it('names the chat\'s routines for the confirmation', async () => {
    const body = (await (await fetch(`${base}/api/chat/sessions/11111111-1111-4111-8111-111111111111/routines`)).json()) as { routines: Array<{ name: string }> };
    assert.deepEqual(body.routines.map((r) => r.name), ['Morgenbericht']);
  });

  it('pauses them and removes only this chat\'s transcripts on delete', async () => {
    const res = await fetch(`${base}/api/chat/sessions/11111111-1111-4111-8111-111111111111`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, routinesPaused: 1 });
    assert.deepEqual(paused, ['11111111-1111-4111-8111-111111111111']);
    // #2318 — the delete and the routine it paused are in the admin audit.
    assert.deepEqual(audited, [
      {
        actor: { id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', email: 'owner@example.test' },
        action: 'chat.delete',
        target: 'chat:11111111-1111-4111-8111-111111111111',
        after: { kind: 'web', transcriptsPurged: true, routinesPaused: ['routine:r1'] },
      },
    ]);
    assert.equal(await memory.directoryExists('/memories/sessions/11111111-1111-4111-8111-111111111111'), false);
    assert.equal(await memory.fileExists('/memories/sessions/22222222-2222-4222-8222-222222222222/2026-11-26.md'), true);
  });

  it('touches nothing for an id that is not an existing web chat (another scope, a shared bucket)', async () => {
    await memory.createFile('/memories/sessions/routine-abc/2026-11-26.md', '# routine');
    await memory.createFile('/memories/sessions/http-default/2026-11-26.md', '# shared');
    const before = paused.length;
    for (const id of ['routine-abc', 'http-default', '33333333-3333-4333-8333-333333333333']) {
      const res = await fetch(`${base}/api/chat/sessions/${id}`, { method: 'DELETE' });
      assert.deepEqual(await res.json(), { ok: true, routinesPaused: 0 });
    }
    assert.equal(paused.length, before);
    // Nothing was stored under these ids: nothing was deleted, nothing audited.
    assert.equal(audited.length, 1);
    assert.equal(await memory.fileExists('/memories/sessions/routine-abc/2026-11-26.md'), true);
    assert.equal(await memory.fileExists('/memories/sessions/http-default/2026-11-26.md'), true);
  });
});
