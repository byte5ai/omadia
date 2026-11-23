/**
 * OM-76 (#996) — "no orchestrator at all" vs "this one is gone".
 *
 * Two states the chat UI must tell apart:
 *   - NO agent is active (none exists or is enabled, or no LLM provider is
 *     assigned) → 503 `no_agents_active`, whose message names both fixes.
 *   - some agents ARE active, the requested one is gone → since #2055 the
 *     management layer answers: 200 with a `system` notice naming the agent,
 *     on both the JSON and the NDJSON route. Never another agent, never 503.
 */
import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import type { ChatAgent } from '@omadia/orchestrator';
import { createChatRouter, NO_AGENTS_ACTIVE_MESSAGE } from '../src/routes/chat.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import { routeTurnFrom } from './_helpers/webRouteTurn.js';

const SLUG = 'default';

describe('createChatRouter — OM-76 no_agents_active vs a notice for a missing agent', () => {
  let server: Server;
  let baseUrl: string;
  let streamUrl: string;
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
        routeTurn: routeTurnFrom(
          (slug) => activeAgents.get(slug),
          () => SLUG,
        ),
        hasActiveAgents: () => hasActive,
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/chat`;
    streamUrl = `${baseUrl}/stream`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(() => {
    activeAgents.clear();
    hasActive = true;
  });

  async function post(url = baseUrl): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
  }

  it('no active agents at all → 503 no_agents_active', async () => {
    hasActive = false; // registry empty, nothing published
    const res = await post();
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'no_agents_active');
    // The registry cannot tell "no agent exists or is enabled" from "no LLM
    // provider": a fresh instance with a provider but no agent hits this too,
    // so the message names both fixes, not the provider alone.
    assert.equal(body.message, NO_AGENTS_ACTIVE_MESSAGE);
    assert.match(body.message, /create or enable an agent/);
    assert.match(body.message, /LLM provider/);
  });

  it('agents active but the default one is gone → 200 system notice naming it', async () => {
    hasActive = true; // some agent exists, just not `default`
    const res = await post();
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      answer: string;
      speaker: { kind: string };
      systemNotice: { code: string; agent?: { slug: string } };
    };
    assert.deepEqual(body.speaker, { kind: 'system' });
    assert.equal(body.systemNotice.agent?.slug, SLUG);
    assert.equal(body.answer, (body.systemNotice as { text?: string }).text);
  });

  it('stream: a notice is one `done` event from system, no agent_bound', async () => {
    hasActive = true;
    const res = await post(streamUrl);
    assert.equal(res.status, 200);
    const events = (await res.text())
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.length, 1, JSON.stringify(events));
    const [done] = events;
    assert.equal(done?.['type'], 'done');
    assert.deepEqual(done?.['speaker'], { kind: 'system' });
    const notice = done?.['systemNotice'] as { code: string; text: string } | undefined;
    assert.ok(notice);
    assert.equal(done?.['answer'], notice.text);
  });
});
