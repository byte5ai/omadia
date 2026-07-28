import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import type { IncomingTurn } from '@omadia/channel-sdk';

import { createApiKeyStore } from '../../packages/harness-channel-api/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-channel-api/src/auditLog.js';
import { createRateLimiter } from '../../packages/harness-channel-api/src/rateLimiter.js';
import { createApiChatRouter } from '../../packages/harness-channel-api/src/chatRouter.js';
import { createFakeSecrets } from './testSecrets.js';

/** Parses an NDJSON response body (one JSON object per line) into events. */
function parseNdjson(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe('channelApi/chatRouter — wiring (auth, rate limit, audit, NDJSON framing)', () => {
  let server: Server;
  let baseUrl: string;
  let apiKeys: ReturnType<typeof createApiKeyStore>;
  let auditLog: ReturnType<typeof createAuditLog>;
  let rateLimiter: ReturnType<typeof createRateLimiter>;
  const capturedTurns: IncomingTurn[] = [];

  before(() => {
    const secrets = createFakeSecrets();
    apiKeys = createApiKeyStore(secrets);
    auditLog = createAuditLog(secrets);
    rateLimiter = createRateLimiter();

    const app = express();
    app.use(express.json());
    app.use(
      createApiChatRouter({
        channelId: '@omadia/channel-api',
        apiKeys,
        auditLog,
        rateLimiter,
        core: {
          async *handleTurnStream(turn: IncomingTurn) {
            capturedTurns.push(turn);
            yield { type: 'agent_bound', slug: 'general' };
            yield { type: 'text_delta', text: `echo: ${turn.text}` };
            yield { type: 'done', answer: `echo: ${turn.text}`, toolCalls: 0, iterations: 1 };
          },
        },
      }),
    );
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/chat`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('401s when no Authorization header is sent', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 401);
  });

  it('401s for an unknown API key', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer omk_not-a-real-key' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 401);
  });

  it('streams an NDJSON turn end-to-end for a valid key, and audits the call', async () => {
    const created = await apiKeys.create({ label: 'streamer' });
    const before = (await auditLog.list()).length;

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'ping', conversationId: 'conv-1' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);

    const events = parseNdjson(await res.text());
    assert.deepEqual(
      events.map((e) => (e as { type: string }).type),
      ['agent_bound', 'text_delta', 'done'],
    );

    assert.equal(capturedTurns.length, 1);
    assert.equal(capturedTurns[0]?.channelId, '@omadia/channel-api');
    assert.equal(capturedTurns[0]?.conversationId, 'conv-1');
    assert.equal(capturedTurns[0]?.text, 'ping');
    // Design decision (issue #438): the key IS its own identity.
    assert.deepEqual(capturedTurns[0]?.userRef, {
      kind: 'custom',
      id: `key:${created.record.id}`,
      displayName: 'streamer',
    });

    const after = await auditLog.list();
    assert.equal(after.length, before + 1, 'exactly one audit row per authenticated call');
    const last = after[after.length - 1];
    assert.equal(last?.keyId, created.record.id);
    assert.equal(last?.route, '/chat');
    assert.equal(last?.method, 'POST');
  });

  it('401s once the key has been revoked — no further calls succeed', async () => {
    const created = await apiKeys.create({ label: 'to-revoke' });
    const first = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(first.status, 200);

    await apiKeys.revoke(created.record.id);

    const second = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'hi again' }),
    });
    assert.equal(second.status, 401);
  });

  it('429s once a key exceeds its configured rate limit', async () => {
    const created = await apiKeys.create({ label: 'limited', rateLimitPerMinute: 1 });
    const first = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'one' }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'two' }),
    });
    assert.equal(second.status, 429);
  });

  it('400s on an empty message', async () => {
    const created = await apiKeys.create({ label: 'validator' });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: '' }),
    });
    assert.equal(res.status, 400);
  });
});
