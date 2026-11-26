/**
 * #1884 — "Kill sessions" / "Drain sessions" found no web chat.
 *
 * The chat route pins a session to its agent on the first turn (`snapshot`,
 * ADR-0146), and the web UI then PUTs the whole document back. The PUT
 * schema has no `snapshot` and the merge kept only `resetAt`, so every pin
 * was gone after the first client save, and `forceInvalidate`, which matches
 * on the pin, matched nothing. The pin is server-owned now, like `resetAt`.
 */
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore, OrchestratorRegistry } from '@omadia/orchestrator';
import type { ChatSession, SessionConfigSnapshot } from '@omadia/orchestrator';

import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const T0 = 1_700_000_000_000;

function session(id: string): ChatSession {
  return {
    id,
    title: 'Chat',
    createdAt: T0,
    updatedAt: T0,
    messages: [
      { id: `${id}-u`, role: 'user', content: 'Hallo', startedAt: T0 },
      { id: `${id}-a`, role: 'assistant', content: 'Hi', startedAt: T0 + 1, finishedAt: T0 + 2 },
    ],
  };
}

function pin(agentSlug: string): () => Promise<SessionConfigSnapshot> {
  return () => Promise.resolve({ agentSlug, pluginIds: [], toolIds: [], memoryScope: [], capturedAt: T0 });
}

/** `forceInvalidate` needs nothing of the registry but its log. */
function forceInvalidate(slug: string, mode: 'drain' | 'kill', store: ChatSessionStore): Promise<number> {
  return OrchestratorRegistry.prototype.forceInvalidate.call(
    { log: () => undefined } as unknown as OrchestratorRegistry,
    slug,
    mode,
    store,
  );
}

describe('#1884 — the agent pin survives the client PUT', () => {
  let server: Server;
  let base: string;
  let store: ChatSessionStore;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatSessionsRouter({ getStore: () => store }));
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/chat`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    store = new ChatSessionStore(new InMemoryMemoryStore());
  });

  /** What the web UI does: create the chat, the turn pins it, then save the turn. */
  async function chatWith(id: string, agentSlug: string): Promise<void> {
    await store.save({ ...session(id), messages: [] });
    await store.captureSnapshot(id, pin(agentSlug));
    const res = await fetch(`${base}/sessions/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session(id)),
    });
    assert.equal(res.status, 200);
  }

  it('a client PUT keeps the stored pin and cannot set one', async () => {
    await chatWith('s1', 'dritter');
    assert.equal((await store.get('s1'))?.snapshot?.agentSlug, 'dritter');

    await store.save(session('s2'));
    await fetch(`${base}/sessions/s2`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...session('s2'), snapshot: { agentSlug: 'dritter' } }),
    });
    assert.equal((await store.get('s2'))?.snapshot, undefined);
  });

  it('kill deletes the chats pinned to the agent and only those', async () => {
    await chatWith('s1', 'dritter');
    await chatWith('s2', 'other');
    assert.equal(await forceInvalidate('dritter', 'kill', store), 1);
    assert.equal(await store.get('s1'), null);
    assert.ok(await store.get('s2'));
  });

  it('drain drops the pin and keeps the history', async () => {
    await chatWith('s1', 'dritter');
    assert.equal(await forceInvalidate('dritter', 'drain', store), 1);
    const drained = await store.get('s1');
    assert.equal(drained?.snapshot, undefined);
    assert.equal(drained?.messages.length, 2);
  });
});
