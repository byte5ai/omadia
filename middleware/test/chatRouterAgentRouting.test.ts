/**
 * Phase A / TA09 — chat router per-Agent resolution tests.
 *
 *  1. No agentSlug + no default agent → 200 `no_agent` notice from `system`
 *     (#2055: there is no fallback agent and no 412 any more)
 *  2. No agentSlug + default agent set → the default's ChatAgent serves
 *  3. agentSlug provided + slug active → that ChatAgent serves the turn
 *  4. agentSlug for an unknown slug → 200 notice naming it, never another agent
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
import { listenLoopback } from './_helpers/listenLoopback.js';
import { routeTurnFrom } from './_helpers/webRouteTurn.js';

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
  let defaultSlug: string | undefined;
  /** #2314 — live agent ids by slug; a slug absent here has id `id-<slug>`. */
  const agentIds = new Map<string, string>();

  async function mountApp(): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { sub: 'account-1' };
      next();
    });
    app.use(
      '/api',
      createChatRouter({
        legacyChatOwner: () => Promise.resolve('account-1'),
        chatSessionStore: store as unknown as ChatSessionStore,
        routeTurn: routeTurnFrom(
          (slug) => availableAgents.get(slug),
          () => defaultSlug,
        ),
        agentIdForSlug: (slug) => (availableAgents.has(slug) ? (agentIds.get(slug) ?? `id-${slug}`) : undefined),
        snapshotForAgent: (slug) => ({
          agentSlug: slug,
          agentId: agentIds.get(slug) ?? `id-${slug}`,
          pluginIds: [],
          toolIds: [],
          memoryScope: ['core'],
          capturedAt: Date.now(),
        }),
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/chat`;
  }

  before(async () => {
    store = new FakeStore();
    availableAgents = new Map();
    availableAgents.set(SLUG_PUBLIC, fakeChatAgent(SLUG_PUBLIC));
    availableAgents.set(SLUG_GENERAL, fakeChatAgent(SLUG_GENERAL));
    defaultSlug = SLUG_PUBLIC;
    await mountApp();
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    store.sessions.clear();
    availableAgents.clear();
    availableAgents.set(SLUG_PUBLIC, fakeChatAgent(SLUG_PUBLIC));
    availableAgents.set(SLUG_GENERAL, fakeChatAgent(SLUG_GENERAL));
    defaultSlug = SLUG_PUBLIC;
    agentIds.clear();
  });

  it('1: no slug + no default agent → no_agent notice from system', async () => {
    defaultSlug = undefined;
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      answer: string;
      speaker: { kind: string };
      systemNotice: { code: string; text: string };
      agent_slug?: string;
    };
    assert.deepEqual(body.speaker, { kind: 'system' });
    assert.equal(body.systemNotice.code, 'no_agent');
    assert.equal(body.answer, body.systemNotice.text);
    assert.equal(body.agent_slug, undefined, 'no agent answered');
  });

  it('2: no slug + default agent set → the default agent serves', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      answer: string;
      agent_slug: string;
      speaker: { kind: string; slug?: string };
    };
    assert.equal(body.agent_slug, SLUG_PUBLIC);
    assert.equal(body.answer, `hello from ${SLUG_PUBLIC}`);
    assert.equal(body.speaker.kind, 'agent');
    assert.equal(body.speaker.slug, SLUG_PUBLIC);
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

  it('4: explicit slug for an unknown agent → notice naming it, no other agent', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', agentSlug: 'ghost' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      answer: string;
      speaker: { kind: string };
      systemNotice: { code: string; agent?: { slug: string } };
      agent_slug?: string;
    };
    assert.deepEqual(body.speaker, { kind: 'system' });
    assert.equal(body.systemNotice.code, 'agent_unknown');
    assert.equal(body.systemNotice.agent?.slug, 'ghost');
    assert.equal(body.agent_slug, undefined, 'the default agent must not answer instead');
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

  it('8 (#2314): a pin of a deleted agent whose slug was reused → 503 agent_unavailable, the new agent never answers', async () => {
    store.seed('sess-old', {
      agentSlug: SLUG_PUBLIC,
      agentId: 'id-deleted-agent',
      pluginIds: [],
      toolIds: [],
      memoryScope: [],
      capturedAt: Date.now(),
    });
    agentIds.set(SLUG_PUBLIC, 'id-new-agent');
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', sessionId: 'sess-old' }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; reason: string; slug: string };
    assert.equal(body.error, 'agent_unavailable');
    assert.equal(body.reason, 'agent_deleted');
    assert.equal(body.slug, SLUG_PUBLIC);
  });

  it('9 (#2314): a pin with the live id, or a legacy pin without one, still answers', async () => {
    store.seed('sess-live', {
      agentSlug: SLUG_PUBLIC,
      agentId: `id-${SLUG_PUBLIC}`,
      pluginIds: [],
      toolIds: [],
      memoryScope: [],
      capturedAt: Date.now(),
    });
    store.seed('sess-legacy', { agentSlug: SLUG_PUBLIC, pluginIds: [], toolIds: [], memoryScope: [], capturedAt: Date.now() });
    for (const sessionId of ['sess-live', 'sess-legacy']) {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi', sessionId }),
      });
      assert.equal(res.status, 200, sessionId);
    }
  });

  it('10 (#2317): recent routine deliveries go as conversationContextHint, never as extraSystemHint', async () => {
    let seen: ChatTurnInput | undefined;
    availableAgents.set(SLUG_PUBLIC, {
      chat: (input: ChatTurnInput): Promise<ChatTurnResult> => {
        seen = input;
        return Promise.resolve({ kind: 'message', text: 'ok' } as unknown as ChatTurnResult);
      },
      chatStream: () => {
        throw new Error('not used');
      },
    } as unknown as ChatAgent);
    const session = store.seed('sess-deliv');
    session.messages.push({
      role: 'assistant',
      content: 'Morning report: 3 open invoices',
      timestamp: Date.now(),
      proactive: { deliveredAt: Date.now(), routineName: 'Morning' },
    } as unknown as ChatSession['messages'][number]);
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how many open orders?', sessionId: 'sess-deliv' }),
    });
    assert.equal(res.status, 200);
    assert.ok(seen?.conversationContextHint?.includes('Morning report'), 'the delivery is context of the turn');
    assert.equal(seen?.extraSystemHint, undefined, 'and does not take the fast path away');
  });
});
