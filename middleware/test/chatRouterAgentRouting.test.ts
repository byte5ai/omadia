/**
 * Phase A / TA09 — chat router per-Agent resolution tests.
 *
 *  1. No agentSlug + no fallback → 412 no_fallback
 *  2. No agentSlug + fallback set → fallback's ChatAgent serves the turn
 *  3. agentSlug provided + slug active → that ChatAgent serves the turn
 *  4. agentSlug for an inactive slug → 503 agent_unavailable
 *  5. Session has pinned snapshot + matching agentSlug → pinned wins
 *  6. Session has pinned snapshot + DIFFERENT agentSlug → 409 agent_mismatch
 *  7. First turn captures the snapshot (subsequent reads see the pin)
 *
 * Uses a hand-rolled fake ChatSessionStore so we don't drag the real
 * MemoryStore in; the router only needs `get` + `captureSnapshot`.
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type {
  ChatAgent,
  ChatSession,
  ChatSessionStore,
  ChatTurnInput,
  ChatTurnResult,
  SessionConfigSnapshot,
} from '@omadia/orchestrator';
import { createChatRouter } from '../src/routes/chat.js';

function fakeChatAgent(label: string): ChatAgent {
  return {
    chat: (_input: ChatTurnInput): Promise<ChatTurnResult> =>
      Promise.resolve({
        kind: 'message',
        text: `hello from ${label}`,
      } as unknown as ChatTurnResult),
    chatStream: () => {
      throw new Error('not used in these tests');
    },
  } as unknown as ChatAgent;
}

class FakeStore implements Pick<ChatSessionStore, 'get' | 'captureSnapshot'> {
  sessions = new Map<string, ChatSession>();
  async get(id: string): Promise<ChatSession | null> {
    return this.sessions.get(id) ?? null;
  }
  async captureSnapshot(
    id: string,
    source: () => Promise<SessionConfigSnapshot>,
  ): Promise<SessionConfigSnapshot | null> {
    const existing = this.sessions.get(id);
    if (!existing) return null;
    if (existing.snapshot) return existing.snapshot;
    const snap = await source();
    this.sessions.set(id, { ...existing, snapshot: snap, updatedAt: Date.now() });
    return snap;
  }
  seed(id: string, snapshot?: SessionConfigSnapshot): ChatSession {
    const s: ChatSession = {
      id,
      title: 'test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      ...(snapshot ? { snapshot } : {}),
    };
    this.sessions.set(id, s);
    return s;
  }
}

const SLUG_PUBLIC = 'public';
const SLUG_GENERAL = 'general';

describe('createChatRouter (Phase A)', () => {
  let server: Server;
  let baseUrl: string;
  let store: FakeStore;
  let availableAgents: Map<string, ChatAgent>;
  let fallbackSlug: string | undefined;

  function mountApp(): void {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createChatRouter({
        chatSessionStore: store as unknown as ChatSessionStore,
        resolveChatAgent: (slug) => availableAgents.get(slug),
        getDefaultSlug: () => fallbackSlug,
        snapshotForAgent: (slug) => ({
          agentSlug: slug,
          pluginIds: [],
          toolIds: [],
          memoryScope: ['core'],
          capturedAt: Date.now(),
        }),
      }),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/chat`;
  }

  before(() => {
    store = new FakeStore();
    availableAgents = new Map();
    availableAgents.set(SLUG_PUBLIC, fakeChatAgent(SLUG_PUBLIC));
    availableAgents.set(SLUG_GENERAL, fakeChatAgent(SLUG_GENERAL));
    fallbackSlug = SLUG_PUBLIC;
    mountApp();
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    store.sessions.clear();
    availableAgents.clear();
    availableAgents.set(SLUG_PUBLIC, fakeChatAgent(SLUG_PUBLIC));
    availableAgents.set(SLUG_GENERAL, fakeChatAgent(SLUG_GENERAL));
    fallbackSlug = SLUG_PUBLIC;
  });

  it('1: no slug + no fallback → 412 no_fallback', async () => {
    fallbackSlug = undefined;
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 412);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'no_fallback');
  });

  it('2: no slug + fallback set → fallback serves', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { answer: string; agent_slug: string };
    assert.equal(body.agent_slug, SLUG_PUBLIC);
    assert.equal(body.answer, `hello from ${SLUG_PUBLIC}`);
  });

  it('3: explicit slug active → that agent serves', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', agentSlug: SLUG_GENERAL }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { answer: string; agent_slug: string };
    assert.equal(body.agent_slug, SLUG_GENERAL);
    assert.equal(body.answer, `hello from ${SLUG_GENERAL}`);
  });

  it('4: explicit slug for inactive agent → 503 agent_unavailable', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', agentSlug: 'ghost' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; slug: string };
    assert.equal(body.error, 'agent_unavailable');
    assert.equal(body.slug, 'ghost');
  });

  it('5: pinned snapshot + matching slug → pinned wins', async () => {
    store.seed('sess1', {
      agentSlug: SLUG_GENERAL,
      pluginIds: [],
      toolIds: [],
      memoryScope: [],
      capturedAt: Date.now(),
    });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'hi',
        sessionId: 'sess1',
        agentSlug: SLUG_GENERAL,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agent_slug: string };
    assert.equal(body.agent_slug, SLUG_GENERAL);
  });

  it('6: pinned snapshot + DIFFERENT slug → 409 agent_mismatch', async () => {
    store.seed('sess2', {
      agentSlug: SLUG_PUBLIC,
      pluginIds: [],
      toolIds: [],
      memoryScope: [],
      capturedAt: Date.now(),
    });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'hi',
        sessionId: 'sess2',
        agentSlug: SLUG_GENERAL,
      }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; pinned_slug: string };
    assert.equal(body.error, 'agent_mismatch');
    assert.equal(body.pinned_slug, SLUG_PUBLIC);
  });

  it('7: first turn captures the snapshot', async () => {
    store.seed('sess3');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'hi',
        sessionId: 'sess3',
        agentSlug: SLUG_GENERAL,
      }),
    });
    assert.equal(res.status, 200);
    // Give the captureSnapshot promise a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    const session = store.sessions.get('sess3');
    assert.ok(session?.snapshot, 'snapshot captured');
    assert.equal(session.snapshot.agentSlug, SLUG_GENERAL);
  });

  it('7b: second turn on a pinned session needs no agentSlug', async () => {
    store.seed('sess4', {
      agentSlug: SLUG_GENERAL,
      pluginIds: [],
      toolIds: [],
      memoryScope: [],
      capturedAt: Date.now(),
    });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', sessionId: 'sess4' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agent_slug: string };
    assert.equal(body.agent_slug, SLUG_GENERAL);
  });
});
