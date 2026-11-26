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

import { purgeSessionTranscripts } from '../src/plugins/routines/sessionTranscripts.js';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

describe('#1753 / #1757 — deleting a web chat', () => {
  const memory = new InMemoryMemoryStore();
  const store = new ChatSessionStore(memory);
  const paused: string[] = [];
  let server: import('node:http').Server;
  let base = '';

  before(async () => {
    await store.save({ id: 'chat1', title: 't', createdAt: 1, updatedAt: 1, messages: [], ownerUserId: 'u-1' });
    await memory.createFile('/memories/sessions/chat1/2026-11-26.md', '# turn');
    await memory.createFile('/memories/sessions/chat2/2026-11-26.md', '# other chat');
    const app = express();
    app.use(express.json());
    // The session's `sub` owns chats (#1762); tests pick it per request.
    app.use((req, _res, next) => {
      (req as unknown as { session: { sub: string } }).session = { sub: req.header('x-test-sub') ?? 'u-1' };
      next();
    });
    app.use(
      '/api/chat',
      createChatSessionsRouter({
        getStore: () => store,
        purgeTranscripts: (scope) => purgeSessionTranscripts(memory, scope),
        routines: () => ({
          listForChat: (id) => Promise.resolve(id === 'chat1' ? [{ id: 'r1', name: 'Morgenbericht' }] : []),
          pauseForChat: (id) => {
            paused.push(id);
            return Promise.resolve(id === 'chat1' ? 1 : 0);
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
    assert.equal((await fetch(`${base}/api/chat/sessions/chat1/routines`, other)).status, 404);
    const res = await fetch(`${base}/api/chat/sessions/chat1`, { method: 'DELETE', ...other });
    assert.equal(res.status, 404);
    assert.deepEqual(paused, []);
  });

  it('pauses nothing for a chat that was never saved', async () => {
    const res = await fetch(`${base}/api/chat/sessions/chat2`, { method: 'DELETE' });
    assert.deepEqual(await res.json(), { ok: true, routinesPaused: 0 });
    assert.deepEqual(paused, []);
    assert.equal(await memory.fileExists('/memories/sessions/chat2/2026-11-26.md'), true);
  });

  it('names the chat\'s routines for the confirmation', async () => {
    const body = (await (await fetch(`${base}/api/chat/sessions/chat1/routines`)).json()) as { routines: Array<{ name: string }> };
    assert.deepEqual(body.routines.map((r) => r.name), ['Morgenbericht']);
  });

  it('pauses them and removes only this chat\'s transcripts on delete', async () => {
    const res = await fetch(`${base}/api/chat/sessions/chat1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, routinesPaused: 1 });
    assert.deepEqual(paused, ['chat1']);
    assert.equal(await memory.directoryExists('/memories/sessions/chat1'), false);
    assert.equal(await memory.fileExists('/memories/sessions/chat2/2026-11-26.md'), true);
  });
});
