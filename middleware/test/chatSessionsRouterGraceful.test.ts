/**
 * Graceful-degradation tests for the chat-sessions router.
 *
 * The middleware now boots WITHOUT an ANTHROPIC_API_KEY: @omadia/orchestrator
 * publishes the ChatSessionStore only once the key is set (via the Setup
 * Wizard). The router therefore takes a LIVE `getStore` resolver instead of a
 * captured store and must:
 *   1. 503 (`chat_unavailable`) while the store is absent — never crash.
 *   2. Serve normally once the store appears (hot, no restart) — the same
 *      router instance flips from 503 → 200 when `getStore` starts returning
 *      a value, mirroring a post-boot Setup-Wizard key entry.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ChatSession, ChatSessionStore } from '@omadia/orchestrator';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';

class FakeStore implements Pick<ChatSessionStore, 'list'> {
  sessions: ChatSession[] = [];
  async list(): Promise<ChatSession[]> {
    return this.sessions;
  }
}

describe('createChatSessionsRouter — graceful (getStore)', () => {
  let server: Server;
  let baseUrl: string;
  // The live store handle: undefined simulates "chat disabled" (no key yet),
  // assigning it simulates the orchestrator publishing it after the wizard.
  let liveStore: ChatSessionStore | undefined;

  before(() => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/chat',
      createChatSessionsRouter({ getStore: () => liveStore }),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('503s with chat_unavailable while the store is absent', async () => {
    liveStore = undefined;
    const res = await fetch(`${baseUrl}/sessions`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'chat_unavailable');
  });

  it('serves once the store is published — same router, no restart', async () => {
    const store = new FakeStore();
    store.sessions = [
      {
        id: 's1',
        title: 't',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
      } as ChatSession,
    ];
    liveStore = store as unknown as ChatSessionStore;

    const res = await fetch(`${baseUrl}/sessions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: ChatSession[] };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0]?.id, 's1');
  });

  it('flips back to 503 if the store goes away again', async () => {
    liveStore = undefined;
    const res = await fetch(`${baseUrl}/sessions/anything`);
    assert.equal(res.status, 503);
  });
});
