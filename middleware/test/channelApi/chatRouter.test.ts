import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import type { CoreApi, IncomingTurn } from '@omadia/channel-sdk';

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
    // Namespaced by key identity (cross-key isolation fix) — never the raw
    // caller-supplied conversationId on its own.
    assert.equal(capturedTurns[0]?.conversationId, `${created.record.id}:conv-1`);
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

/** Spins up a fresh router + server backed by its own store/log/limiter, for
 *  tests that need to control the `core.handleTurnStream` behavior per case
 *  (throwing, capturing turns) without cross-contaminating the shared
 *  `before()` fixture above. */
function startTestServer(core: Pick<CoreApi, 'handleTurnStream'>): {
  baseUrl: string;
  apiKeys: ReturnType<typeof createApiKeyStore>;
  auditLog: ReturnType<typeof createAuditLog>;
  close: () => Promise<void>;
} {
  const secrets = createFakeSecrets();
  const apiKeys = createApiKeyStore(secrets);
  const auditLog = createAuditLog(secrets);
  const rateLimiter = createRateLimiter();

  const app = express();
  app.use(express.json());
  app.use(createApiChatRouter({ channelId: '@omadia/channel-api', apiKeys, auditLog, rateLimiter, core }));
  const server = app.listen(0);
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(addr.port)}/chat`,
    apiKeys,
    auditLog,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('channelApi/chatRouter — cross-key conversationId isolation (finding #1)', () => {
  it('two different keys sending the identical caller-supplied conversationId never collide on the internal conversationId', async () => {
    const capturedTurns: IncomingTurn[] = [];
    const harness = startTestServer({
      async *handleTurnStream(turn) {
        capturedTurns.push(turn);
        yield { type: 'done', answer: 'ok', toolCalls: 0, iterations: 1 };
      },
    });

    const keyA = await harness.apiKeys.create({ label: 'A' });
    const keyB = await harness.apiKeys.create({ label: 'B' });

    await fetch(harness.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA.token}` },
      body: JSON.stringify({ message: 'hi from A', conversationId: 'shared-thread' }),
    });
    await fetch(harness.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyB.token}` },
      body: JSON.stringify({ message: 'hi from B', conversationId: 'shared-thread' }),
    });

    assert.equal(capturedTurns.length, 2);
    assert.notEqual(
      capturedTurns[0]?.conversationId,
      capturedTurns[1]?.conversationId,
      'identical caller-supplied conversationId must still map to distinct internal scopes per key',
    );
    assert.equal(capturedTurns[0]?.conversationId, `${keyA.record.id}:shared-thread`);
    assert.equal(capturedTurns[1]?.conversationId, `${keyB.record.id}:shared-thread`);

    await harness.close();
  });
});

describe('channelApi/chatRouter — audit-log accuracy for every authenticated outcome (finding #2)', () => {
  it('does NOT audit an unauthenticated call (missing key)', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        yield { type: 'done', answer: 'x', toolCalls: 0, iterations: 1 };
      },
    });

    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 401);
    assert.equal(
      (await harness.auditLog.list()).length,
      0,
      'a call that never authenticated must not produce an audit entry',
    );
    await harness.close();
  });

  it('audits status "rate_limited" for an authenticated call over quota — never "ok"', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        yield { type: 'done', answer: 'x', toolCalls: 0, iterations: 1 };
      },
    });
    const created = await harness.apiKeys.create({ label: 'quota', rateLimitPerMinute: 1 });

    await fetch(harness.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'one' }),
    });
    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'two' }),
    });
    assert.equal(res.status, 429);

    const entries = await harness.auditLog.list();
    assert.equal(entries.length, 2, 'both the accepted and the rejected call are audited');
    assert.equal(entries[0]?.status, 'ok');
    assert.equal(entries[1]?.status, 'rate_limited');
    assert.equal(entries[1]?.keyId, created.record.id);

    await harness.close();
  });

  it('audits status "invalid_request" for a schema-invalid body — never "ok"', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        yield { type: 'done', answer: 'x', toolCalls: 0, iterations: 1 };
      },
    });
    const created = await harness.apiKeys.create({ label: 'validator' });

    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: '' }),
    });
    assert.equal(res.status, 400);

    const entries = await harness.auditLog.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, 'invalid_request');

    await harness.close();
  });

  it('audits status "error" — never "ok" — when the orchestrator throws mid-turn', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        await Promise.resolve();
        throw new Error('orchestrator exploded');
      },
    });
    const created = await harness.apiKeys.create({ label: 'crasher' });

    const res = await fetch(harness.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    // Headers are already flushed (200) before dispatch starts — the error
    // surfaces as an NDJSON event on the wire, not an HTTP error status.
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('orchestrator exploded'));

    const entries = await harness.auditLog.list();
    assert.equal(entries.length, 1, 'exactly one audit row for this authenticated call');
    assert.equal(
      entries[0]?.status,
      'error',
      'a mid-turn throw must be audited as "error", not optimistically as "ok"',
    );

    await harness.close();
  });
});
