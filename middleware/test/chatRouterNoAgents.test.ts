/**
 * OM-76 (#996) — "no orchestrator at all" vs "this one is gone".
 *
 * When the requested slug does not resolve, the 503 must distinguish two
 * states so the chat UI can react correctly:
 *   - some agents ARE active, the pinned one is gone → `agent_unavailable`
 *     (the recovery banner offers "re-bind to default").
 *   - NO agent is active (fresh install, no LLM provider assigned) →
 *     `no_agents_active` (the banner points at LLM access; re-binding to
 *     "default" would just 503 again, because default is the missing thing).
 *
 * `hasActiveAgents` is optional; when omitted the route keeps the old
 * `agent_unavailable` behaviour, which test 4 in chatRouterAgentRouting covers.
 */
import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ChatAgent } from '@omadia/orchestrator';
import { createChatRouter } from '../src/routes/chat.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const SLUG = 'default';

describe('createChatRouter — OM-76 no_agents_active vs agent_unavailable', () => {
  let server: Server;
  let baseUrl: string;
  let activeAgents: Map<string, ChatAgent>;
  let hasActive: boolean;

  before(async () => {
    activeAgents = new Map();
    hasActive = true;
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createChatRouter({
        resolveChatAgent: (slug) => activeAgents.get(slug),
        getDefaultSlug: () => SLUG,
        hasActiveAgents: () => hasActive,
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    activeAgents.clear();
    hasActive = true;
  });

  async function post(): Promise<Response> {
    return fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
  }

  it('no active agents at all → 503 no_agents_active', async () => {
    hasActive = false; // registry empty, nothing published
    const res = await post();
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; slug?: string };
    assert.equal(body.error, 'no_agents_active');
    assert.equal(body.slug, SLUG);
  });

  it('agents active but the requested one is gone → 503 agent_unavailable', async () => {
    hasActive = true; // some agent exists, just not `default`
    const res = await post();
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'agent_unavailable');
  });
});
