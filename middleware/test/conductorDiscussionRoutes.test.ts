import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import { createConductorRouter } from '../src/conductor/routes.js';
import type { ConductorRouterDeps } from '../src/conductor/routes.js';
import {
  DiscussionConversationBusyError,
  DiscussionInvalidInputError,
} from '../src/conductor/discussionService.js';

// `POST /discussions` — the operator's start button for an agent topic
// conversation. Same in-process express harness as the other router tests.

const servers: Server[] = [];

async function startApp(discussionService: unknown): Promise<{ baseUrl: string; starts: unknown[] }> {
  const starts: unknown[] = [];
  const deps = {
    workflowStore: {},
    runStore: {},
    awaitStore: {},
    roleStore: {},
    scheduleStore: {},
    executor: {},
    eventRouter: {},
    ...(discussionService === undefined
      ? {}
      : {
          discussionService: {
            start: async (input: unknown) => {
              starts.push(input);
              return (discussionService as (i: unknown) => unknown)(input);
            },
          },
        }),
  } as unknown as ConductorRouterDeps;

  const app: Express = express();
  app.use(express.json());
  app.use('/api/v1/operator/conductors', createConductorRouter(deps));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/conductors`, starts };
}

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

const JSON_HEADERS = { 'content-type': 'application/json' };
const handle = {
  runId: 'run-1',
  workflowId: 'wf-1',
  workflowSlug: 'eph-discussion-abc',
  expiresAt: new Date(0).toISOString(),
};
const body = {
  conversationId: 'conv-1',
  agentA: 'hr',
  agentB: 'accounting',
  topic: 'Weiterbildungsbudgets',
};

describe('POST /discussions', () => {
  it('starts a discussion and returns the run handle', async () => {
    const { baseUrl, starts } = await startApp(() => handle);
    const res = await fetch(`${baseUrl}/discussions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), handle);
    // channelType defaults to teams — the only channel with a conversation-send provider today.
    assert.equal((starts[0] as { channelType: string }).channelType, 'teams');
  });

  it('passes an explicit guiding question through', async () => {
    const { baseUrl, starts } = await startApp(() => handle);
    await fetch(`${baseUrl}/discussions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, guidingQuestion: 'Wer trägt die Kosten?' }),
    });
    assert.equal((starts[0] as { guidingQuestion?: string }).guidingQuestion, 'Wer trägt die Kosten?');
  });

  it('answers 400 on invalid input', async () => {
    const { baseUrl } = await startApp(() => {
      throw new DiscussionInvalidInputError('topic is required');
    });
    const res = await fetch(`${baseUrl}/discussions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, topic: '' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, 'conductor.discussion_invalid');
  });

  it('answers 409 when the conversation already hosts another workflow', async () => {
    const { baseUrl } = await startApp(() => {
      throw new DiscussionConversationBusyError('wf-other');
    });
    const res = await fetch(`${baseUrl}/discussions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, 'conductor.discussion_conversation_busy');
  });

  it('answers 400 when a kernel guardrail refuses the ephemeral run', async () => {
    const { baseUrl } = await startApp(() => {
      const err = new Error('ephemeral run quota exceeded: 3 concurrent run(s) per agent');
      err.name = 'EphemeralQuotaExceededError';
      throw err;
    });
    const res = await fetch(`${baseUrl}/discussions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, 'conductor.discussion_refused');
  });

  it('answers 501 on a host without the discussion service (no Postgres)', async () => {
    const { baseUrl } = await startApp(undefined);
    const res = await fetch(`${baseUrl}/discussions`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as { code?: string }).code, 'conductor.discussions_unavailable');
  });
});
