/**
 * #1071 — a routine delivery the server appends to a web chat must survive
 * the web UI's next whole-document PUT.
 *
 * The web UI hydrates once per page load and PUTs the ENTIRE session after
 * every turn. Before the fix the PUT handler overwrote the stored document,
 * so any open tab's next turn silently deleted a routine's proactive message.
 * The zod schema also stripped the `proactive` marker (the #445 trap).
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore } from '@omadia/orchestrator';
import type { ChatMessage, ChatSession } from '@omadia/orchestrator';

import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const ID = 'tab-1';
const T0 = 1_700_000_000_000;

function msg(id: string, role: 'user' | 'assistant', startedAt: number): ChatMessage {
  return { id, role, content: `${role}-${id}`, startedAt, finishedAt: startedAt };
}

/** What the tab hydrated at page load: one completed turn. */
function clientCopy(extra: ChatMessage[] = []): ChatSession {
  return {
    id: ID,
    title: 'Routinen',
    createdAt: T0,
    updatedAt: T0 + 10,
    messages: [msg('u1', 'user', T0), msg('a1', 'assistant', T0 + 1), ...extra],
  };
}

describe('#1071 — PUT /sessions/:id keeps server-written proactive messages', () => {
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

  beforeEach(async () => {
    store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(clientCopy());
  });

  async function put(session: ChatSession): Promise<{ status: number; body: { session: ChatSession } }> {
    const res = await fetch(`${base}/sessions/${ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    });
    return { status: res.status, body: (await res.json()) as { session: ChatSession } };
  }

  async function stored(): Promise<ChatSession> {
    const s = await store.get(ID);
    assert.ok(s);
    return s;
  }

  it('a stale PUT without the delivery keeps it, in order, and bumps updatedAt', async () => {
    const deliveredAt = T0 + 5;
    assert.equal(
      await store.appendProactiveMessage(ID, {
        content: 'Report',
        deliveredAt,
        routineId: 'r1',
        routineName: 'Daily',
      }),
      'appended',
    );
    const before = Date.now();

    // The tab never saw the delivery and ran one more turn after it.
    const res = await put(clientCopy([msg('u2', 'user', T0 + 20), msg('a2', 'assistant', T0 + 21)]));

    assert.equal(res.status, 200);
    const ids = (await stored()).messages.map((m) => m.id);
    assert.deepEqual(ids, ['u1', 'a1', `proactive-r1-${String(deliveredAt)}`, 'u2', 'a2']);
    assert.ok((await stored()).updatedAt >= before, 'updatedAt moves past the stale copy');
    assert.deepEqual(
      res.body.session.messages.map((m) => m.id),
      ids,
      'the response carries the merged document',
    );
  });

  it('an empty PUT is an explicit clear and removes the delivery too', async () => {
    await store.appendProactiveMessage(ID, { content: 'Report', deliveredAt: T0 + 5 });

    await put({ ...clientCopy(), messages: [] });

    assert.deepEqual((await stored()).messages, []);
  });

  it('does not trust a proactive marker the client minted', async () => {
    const forged: ChatMessage = {
      ...msg('x1', 'assistant', T0 + 2),
      proactive: { deliveredAt: T0 + 2, routineId: 'fake' },
    };
    await put(clientCopy([forged]));

    const kept = (await stored()).messages.find((m) => m.id === 'x1');
    assert.ok(kept);
    assert.equal(kept.proactive, undefined, 'marker stripped');

    // …so a later PUT that drops it does not resurrect it.
    await put(clientCopy());
    assert.equal((await stored()).messages.some((m) => m.id === 'x1'), false);
  });

  it('the marker survives a GET → PUT round trip (schema accepts it)', async () => {
    await store.appendProactiveMessage(ID, {
      content: 'Report',
      deliveredAt: T0 + 5,
      routineId: 'r1',
      routineName: 'Daily',
    });
    const fetched = (await (await fetch(`${base}/sessions/${ID}`)).json()) as ChatSession;

    await put(fetched);

    const delivered = (await stored()).messages.at(-1);
    assert.deepEqual(delivered?.proactive, {
      deliveredAt: T0 + 5,
      routineId: 'r1',
      routineName: 'Daily',
    });
    assert.equal((await stored()).messages.length, 3, 'no duplicate');
  });
});

describe('#1071 — the per-session lock spans ChatSessionStore instances', () => {
  // Each orchestrator builds its own store over the same chat-sessions
  // directory (buildOrchestrator), so the lock must not be per instance.
  it('a stale merge-save from one instance cannot drop a delivery another instance is appending', async () => {
    const memory = new InMemoryMemoryStore();
    const webSender = new ChatSessionStore(memory);
    const putRoute = new ChatSessionStore(memory);
    await webSender.save(clientCopy());

    const [outcome] = await Promise.all([
      webSender.appendProactiveMessage(ID, { content: 'Report', deliveredAt: T0 + 5, routineId: 'r1' }),
      putRoute.saveFromClient(clientCopy()),
    ]);

    assert.equal(outcome, 'appended');
    const ids = (await putRoute.get(ID))?.messages.map((m) => m.id);
    assert.deepEqual(ids, ['u1', 'a1', `proactive-r1-${String(T0 + 5)}`]);
  });

  it('a client save repairs a corrupt stored file instead of failing', async () => {
    const memory = new InMemoryMemoryStore();
    await memory.writeFile(`/memories/chat-sessions/${ID}.json`, '{not json');
    const chats = new ChatSessionStore(memory);

    const stored = await chats.saveFromClient(clientCopy());

    assert.deepEqual(stored.messages.map((m) => m.id), ['u1', 'a1']);
    assert.deepEqual((await chats.get(ID))?.messages.map((m) => m.id), ['u1', 'a1']);
  });

  it('a reset racing a delete on another instance does not bring the chat back', async () => {
    const memory = new InMemoryMemoryStore();
    const a = new ChatSessionStore(memory);
    const b = new ChatSessionStore(memory);
    await a.save(clientCopy());

    await Promise.all([a.delete(ID), b.resetMessages(ID)]);

    assert.equal(await b.get(ID), null);
  });
});
