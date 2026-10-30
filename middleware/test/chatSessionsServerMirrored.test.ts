/**
 * Only the web client creates chat sessions.
 *
 * The SessionLogger mirrors completed turns into the chat-session store. It
 * used to CREATE a document when none existed, for any scope that passed the
 * id regex once sanitized — so canvas (`@omadia/ui-channel::<user>::<id>`),
 * routine (`routine:<id>`) and other channel conversations showed up in the
 * WebUI chat list. Pins the three parts of the fix: the mirror appends only
 * to an existing session, the raw scope is what is checked, and documents
 * the old mirror already created are recognised, purged and not re-created
 * by a browser that cached them.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryMemoryStore } from '@omadia/memory';
import {
  ChatSessionStore,
  ServerMirroredSessionError,
  SessionLogger,
  isChatSessionScope,
  isServerMirroredSession,
} from '@omadia/orchestrator';
import type { ChatMessage, ChatSession } from '@omadia/orchestrator';

import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const WEB_ID = '04cd6537-9b80-4403-a213-d97260d7c9a3';
const CANVAS_ID = 'omadia-ui-channel-marcel-7ab3b86e';
const ROUTINE_ID = 'routine-5e8ef12f-bc8f-417d-98ac-18e83f841185';
const T0 = 1_700_000_000_000;

const TURN = {
  userMessage: 'Wie sind die Urlaubsregeln?',
  assistantMessage: '30 Tage.',
  startedAt: T0,
  finishedAt: T0 + 100,
};

function clientMsg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, startedAt: T0, finishedAt: T0 };
}

function serverMsg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: `srv-${id}`, role, content, startedAt: T0, finishedAt: T0 };
}

function session(id: string, messages: ChatMessage[]): ChatSession {
  return { id, title: 'T', createdAt: T0, updatedAt: T0, messages };
}

const mirroredCanvas = (): ChatSession =>
  session(CANVAS_ID, [serverMsg('u-1', 'user', 'rows?'), serverMsg('a-1', 'assistant', 'rows.')]);
const mirroredRoutine = (): ChatSession =>
  session(ROUTINE_ID, [serverMsg('u-2', 'user', 'check'), serverMsg('a-2', 'assistant', 'ok')]);
const webChat = (): ChatSession =>
  session(WEB_ID, [clientMsg('u1', 'user', 'hi'), clientMsg('a1', 'assistant', 'hello')]);

describe('isChatSessionScope — the raw scope decides', () => {
  it('a web session id (UUID) is a chat scope', () => {
    assert.equal(isChatSessionScope(WEB_ID), true);
  });

  it('canvas, routine and other channel scopes are not — even though they sanitize to valid ids', () => {
    assert.equal(isChatSessionScope('@omadia/ui-channel::marcel::7ab3b86e'), false);
    assert.equal(isChatSessionScope('routine:5e8ef12f'), false);
    assert.equal(isChatSessionScope('discord::1511626209535197256'), false);
  });

  it('http-* and teams-* stay excluded', () => {
    assert.equal(isChatSessionScope('http-default'), false);
    assert.equal(isChatSessionScope('teams-19abc'), false);
  });
});

describe('isServerMirroredSession', () => {
  it('matches a non-UUID id whose every message the mirror wrote', () => {
    assert.equal(isServerMirroredSession(mirroredCanvas()), true);
    assert.equal(isServerMirroredSession(mirroredRoutine()), true);
  });

  it('never matches a UUID id, whatever the messages', () => {
    assert.equal(isServerMirroredSession(webChat()), false);
    assert.equal(
      isServerMirroredSession(session(WEB_ID, [serverMsg('u-1', 'user', 'q'), serverMsg('a-1', 'assistant', 'a')])),
      false,
    );
  });

  it('an empty document is a web chat awaiting its first turn', () => {
    assert.equal(isServerMirroredSession(session('id-lx3-abc', [])), false);
  });

  it('a client-authored message anywhere makes it a web chat (legacy non-UUID ids included)', () => {
    assert.equal(
      isServerMirroredSession(session('legacy-scope-1', [clientMsg('u1', 'user', 'hi'), serverMsg('a-1', 'assistant', 'x')])),
      false,
    );
  });

  it("never matches the web client's `id-<time>-<random>` fallback id, even with only mirrored messages", () => {
    // Plain-HTTP LAN host (no crypto.randomUUID) + lost create-PUT + mid-stream
    // reload leaves a real web chat holding only the mirror's pair.
    assert.equal(
      isServerMirroredSession(session('id-lx3k2-abc12345', [serverMsg('u-1', 'user', 'q'), serverMsg('a-1', 'assistant', 'a')])),
      false,
    );
  });
});

describe('SessionLogger.log — the mirror is gated on the RAW scope', () => {
  async function logged(scope: string, preSaved: ChatSession): Promise<ChatSession | null> {
    const memory = new InMemoryMemoryStore();
    const chats = new ChatSessionStore(memory);
    await chats.save(preSaved);
    const logger = new SessionLogger(memory, undefined, chats);

    await logger.log({ scope, userMessage: TURN.userMessage, assistantAnswer: TURN.assistantMessage });

    return chats.get(preSaved.id);
  }

  it('a routine scope is not mirrored into the document its sanitized form would name', async () => {
    const after = await logged('routine:5e8ef12f', session('routine-5e8ef12f', []));
    assert.deepEqual(after?.messages, []);
  });

  it('a canvas scope is not mirrored either', async () => {
    const after = await logged('@omadia/ui-channel::marcel::7ab3b86e', session('omadia-ui-channel-marcel-7ab3b86e', []));
    assert.deepEqual(after?.messages, []);
  });

  it('a web session id is mirrored into its existing document', async () => {
    const after = await logged(WEB_ID, session(WEB_ID, []));
    assert.deepEqual(after?.messages.map((m) => m.role), ['user', 'assistant']);
    assert.ok(after?.messages.every((m) => m.id.startsWith('srv-')));
  });
});

describe('appendTurnFromServer — appends, never creates', () => {
  it('does nothing when the session does not exist', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());

    await store.appendTurnFromServer(CANVAS_ID, TURN);
    await store.appendTurnFromServer(WEB_ID, TURN);

    assert.equal(await store.get(CANVAS_ID), null);
    assert.equal(await store.get(WEB_ID), null);
    assert.deepEqual(await store.list(), []);
  });

  it('appends the pair to a session the client created', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(session(WEB_ID, []));

    await store.appendTurnFromServer(WEB_ID, TURN);

    assert.deepEqual(
      (await store.get(WEB_ID))?.messages.map((m) => m.id),
      [`srv-u-${String(T0)}`, `srv-a-${String(T0 + 100)}`],
    );
  });

  it('skips a pair the client already PUT', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(
      session(WEB_ID, [
        clientMsg('u1', 'user', TURN.userMessage),
        clientMsg('a1', 'assistant', TURN.assistantMessage),
      ]),
    );

    await store.appendTurnFromServer(WEB_ID, TURN);

    assert.deepEqual((await store.get(WEB_ID))?.messages.map((m) => m.id), ['u1', 'a1']);
  });
});

describe('purge of documents the old mirror created', () => {
  it('purgeServerMirrored deletes them and leaves web chats alone', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(webChat());
    await store.save(session('id-legacy', []));
    await store.save(mirroredCanvas());
    await store.save(mirroredRoutine());

    const purged = await store.purgeServerMirrored();

    assert.deepEqual(purged.sort(), [CANVAS_ID, ROUTINE_ID].sort());
    assert.equal(await store.get(CANVAS_ID), null);
    assert.equal(await store.get(ROUTINE_ID), null);
    assert.ok(await store.get(WEB_ID));
    assert.ok(await store.get('id-legacy'));
    assert.deepEqual(await store.purgeServerMirrored(), []);
  });

  it('list() runs the purge once, so the WebUI never sees them', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(webChat());
    await store.save(mirroredCanvas());

    assert.deepEqual((await store.list()).map((s) => s.id), [WEB_ID]);
    assert.equal(await store.get(CANVAS_ID), null);
  });

  it('the sweep runs once: a mirrored-shape document written after it stays', async () => {
    // The purge is a one-time sweep of leftovers; the rule going forward is
    // enforced where documents are created (mirror + client PUT).
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.list();
    await store.save(mirroredCanvas());

    assert.deepEqual((await store.list()).map((s) => s.id), [CANVAS_ID]);
  });

  it('a sweep with a failed delete is retried by the next list()', async () => {
    const memory = new InMemoryMemoryStore();
    const store = new ChatSessionStore(memory);
    await store.save(mirroredCanvas());
    await store.save(mirroredRoutine());
    const realDelete = memory.delete.bind(memory);
    let failOnce = true;
    memory.delete = (path: string) => {
      if (failOnce && path.endsWith(`${CANVAS_ID}.json`)) {
        failOnce = false;
        return Promise.reject(new Error('storage hiccup'));
      }
      return realDelete(path);
    };

    const first = (await store.list()).map((s) => s.id);
    const second = (await store.list()).map((s) => s.id);

    assert.deepEqual(first, [CANVAS_ID]); // the routine one went, the canvas one is still there
    assert.deepEqual(second, []);
  });

  it('a document whose file name and id disagree is not deleted under either name', async () => {
    const memory = new InMemoryMemoryStore();
    const store = new ChatSessionStore(memory);
    await store.save(webChat());
    await memory.writeFile(`/memories/chat-sessions/${CANVAS_ID}.json`, JSON.stringify({ ...mirroredCanvas(), id: WEB_ID }));

    await store.purgeServerMirrored();

    assert.ok(await store.get(WEB_ID));
    assert.ok(await memory.fileExists(`/memories/chat-sessions/${CANVAS_ID}.json`));
  });

  it('a client PUT landing during the sweep is kept — the decision is re-read under the session lock', async () => {
    const memory = new InMemoryMemoryStore();
    const store = new ChatSessionStore(memory);
    await store.save(mirroredCanvas());
    // The sweep lists the directory first; a client's PUT (a tab that still
    // had the transcript open) lands right after that listing.
    const realList = memory.list.bind(memory);
    memory.list = async (dir: string) => {
      const entries = await realList(dir);
      await store.saveFromClient({ ...mirroredCanvas(), messages: [...mirroredCanvas().messages, clientMsg('u9', 'user', 'more')] });
      return entries;
    };

    assert.deepEqual(await store.purgeServerMirrored(), []);
    assert.deepEqual((await store.get(CANVAS_ID))?.messages.map((m) => m.id).at(-1), 'u9');
  });
});

describe('saveFromClient — refuses to re-create a mirrored transcript', () => {
  it('throws ServerMirroredSessionError for a new document of that shape', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());

    await assert.rejects(store.saveFromClient(mirroredCanvas()), ServerMirroredSessionError);

    assert.equal(await store.get(CANVAS_ID), null);
  });

  it('still saves web chats — UUID ids, empty chats, client-authored legacy ids', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());

    await store.saveFromClient(webChat());
    await store.saveFromClient(session('id-legacy', []));
    await store.saveFromClient(session('id-legacy2', [clientMsg('u1', 'user', 'hi')]));

    assert.deepEqual((await store.list()).map((s) => s.id).sort(), [WEB_ID, 'id-legacy', 'id-legacy2'].sort());
  });

  it('an UPDATE of an existing mirrored-shape document is allowed — only creation is refused', async () => {
    const store = new ChatSessionStore(new InMemoryMemoryStore());
    await store.save(mirroredCanvas());

    const stored = await store.saveFromClient({ ...mirroredCanvas(), title: 'renamed' });

    assert.equal(stored.title, 'renamed');
  });

  describe('PUT /sessions/:id answers 409 server_mirrored_session', () => {
    let server: Server;
    let base: string;
    const store = new ChatSessionStore(new InMemoryMemoryStore());

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

    it('refuses the push-back and leaves nothing behind', async () => {
      const res = await fetch(`${base}/sessions/${CANVAS_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mirroredCanvas()),
      });

      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'server_mirrored_session' });
      assert.equal(await store.get(CANVAS_ID), null);
    });
  });
});
