/**
 * #2055 — `/agent …` in the web chat (review finding): the command is the
 * management layer's, answered from `system`, no agent turn runs, the session
 * is not pinned by it, and choosing an agent releases the existing pin so the
 * next message routes by the new selection instead of the old agent.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { buildSystemNotice, type ChatAgent, type ChatSession, type ChatSessionStore } from '@omadia/orchestrator';
import { createChatRouter, type WebRouteRequest } from '../src/routes/chat.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

describe('web chat /agent command', () => {
  let server: Server;
  let baseUrl: string;
  const routed: WebRouteRequest[] = [];
  const cleared: string[] = [];
  let agentRuns = 0;
  const session: ChatSession = {
    id: 'sess1',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    snapshot: { agentSlug: 'old', pluginIds: [], toolIds: [], memoryScope: [], capturedAt: 1 },
  };
  const store = {
    get: async () => session,
    captureSnapshot: async () => session.snapshot ?? null,
    clearSnapshot: async (id: string) => {
      cleared.push(id);
    },
  } as unknown as ChatSessionStore;
  const agent = {
    chat: async () => {
      agentRuns += 1;
      return { text: 'agent' };
    },
  } as unknown as ChatAgent;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createChatRouter({
        chatSessionStore: store,
        routeTurn: (request) => {
          routed.push(request);
          return { kind: 'agent', chatAgent: agent, slug: 'old', speaker: { kind: 'agent', agentId: 'id-old', slug: 'old', displayName: 'Old' } };
        },
        handleAgentCommand: async (command) =>
          command.kind === 'select'
            ? buildSystemNotice('agent_selected', { agent: { slug: 'mira', displayName: 'Mira' }, locale: 'en' })
            : buildSystemNotice('agent_directory', { items: ['Mira'], locale: 'en' }),
      }),
    );
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = async (message: string) =>
    (await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId: 'sess1' }),
    }).then((r) => r.json())) as { answer: string; speaker?: { kind: string }; systemNotice?: { code: string } };

  it('/agent Mira is answered from system, runs no agent and releases the pin', async () => {
    const body = await post('/agent Mira');
    assert.equal(body.systemNotice?.code, 'agent_selected');
    assert.equal(body.speaker?.kind, 'system');
    assert.equal(agentRuns, 0);
    assert.equal(routed.length, 0);
    assert.deepEqual(cleared, ['sess1']);
  });

  it('/agents lists without touching the pin', async () => {
    cleared.length = 0;
    const body = await post('/agents');
    assert.equal(body.systemNotice?.code, 'agent_directory');
    assert.deepEqual(cleared, []);
  });

  it('ordinary text still reaches the routed agent', async () => {
    const body = await post('Hallo');
    assert.equal(body.answer, 'agent');
    assert.equal(agentRuns, 1);
  });
});
