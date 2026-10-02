/**
 * The server-side chat mirror (`PUT /api/chat/sessions/:id`) validates each
 * message against a whitelist schema, and zod drops every key it does not
 * list. A message's verifier summary and its withheld-answer marker must
 * survive that, or a session resumed from the mirror shows a withheld answer
 * as an ordinary reply without its verdict. A summary that does not fit the
 * schema is dropped on its own; it never fails the whole session write.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ChatSession, ChatSessionStore } from '@omadia/orchestrator';
import { createChatSessionsRouter } from '../src/routes/chatSessions.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const SUMMARY = {
  badge: 'failed',
  status: 'blocked',
  claimCount: 1,
  contradictionCount: 1,
  unverifiedCount: 0,
  uncheckedCount: 0,
  uncoveredCount: 0,
  retryCount: 0,
  latencyMs: 12,
  mode: 'enforce',
};

function session(message: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'sess-1',
    title: 't',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      { id: 'm1', role: 'user', content: 'Wie hoch war der Umsatz?', startedAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Diese Antwort wurde zurückgehalten.', startedAt: 1, ...message },
    ],
  };
}

describe('chat-session mirror — verifier fields', () => {
  let server: Server;
  let baseUrl: string;
  const saved: ChatSession[] = [];

  before(async () => {
    // The PUT route persists through `saveFromClient` (#1071), which keeps
    // server-written proactive messages; this stub records what reaches it.
    const store = {
      save(s: ChatSession): Promise<void> {
        saved.push(s);
        return Promise.resolve();
      },
      saveFromClient(s: ChatSession): Promise<ChatSession> {
        saved.push(s);
        return Promise.resolve(s);
      },
    } as unknown as ChatSessionStore;
    const app = express();
    app.use(express.json());
    app.use('/api/chat', createChatSessionsRouter({ getStore: () => store }));
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function put(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    saved.length = 0;
    const res = await fetch(`${baseUrl}/sessions/sess-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return saved[0]?.messages[1] as Record<string, unknown> | undefined;
  }

  it('keeps the verifier summary and the withheld marker', async () => {
    const stored = await put(session({ verifier: SUMMARY, verifierBlocked: true }));
    assert.deepEqual(stored?.['verifier'], SUMMARY);
    assert.equal(stored?.['verifierBlocked'], true);
  });

  it('keeps the reason of an answer withheld behind the privacy shield', async () => {
    const summary = {
      ...SUMMARY,
      badge: 'unavailable',
      status: 'unavailable',
      reason: 'privacy_shield',
      claimCount: 0,
      contradictionCount: 0,
    };
    const stored = await put(session({ verifier: summary, verifierBlocked: true }));
    assert.deepEqual(stored?.['verifier'], summary);
  });

  it('drops a summary that does not fit, and still saves the session', async () => {
    const stored = await put(
      session({ verifier: { ...SUMMARY, badge: 'trust-me' }, verifierBlocked: 'yes' }),
    );
    assert.equal(stored?.['verifier'], undefined);
    assert.equal(stored?.['verifierBlocked'], undefined);
    assert.equal(stored?.['content'], 'Diese Antwort wurde zurückgehalten.');
  });
});
