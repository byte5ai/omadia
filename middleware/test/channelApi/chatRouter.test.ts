import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import express from 'express';
import type { CoreApi, IncomingTurn } from '@omadia/channel-sdk';

import { createApiKeyStore } from '../../packages/harness-api-key-auth/src/apiKeyStore.js';
import { createAuditLog } from '../../packages/harness-api-key-auth/src/auditLog.js';
import { createRateLimiter } from '../../packages/harness-api-key-auth/src/rateLimiter.js';
import {
  createApiChatRouter,
  internalConversationId,
} from '../../packages/harness-channel-api/src/chatRouter.js';
import { createInProcessClient, type InProcessClient } from '../support/inProcessHttp.js';
// Imported from source (not the `@omadia/channel-sdk` dist barrel): these were
// added in #647, after the last dist build — same rationale as `graphScopeFor`
// below.
import {
  AI_PROVENANCE_HEADER,
  ENVELOPE_PROVENANCE,
} from '../../packages/harness-channel-sdk/src/provenance.js';
import { createFakeSecrets } from './testSecrets.js';
// Import from source: `graphScopeFor` was added after the last dist build,
// so the built `@omadia/orchestrator` barrel doesn't re-export it yet (same
// rationale as test/sessionLoggerGraphScope.test.ts).
import { graphScopeFor } from '../../packages/harness-orchestrator/src/sessionLogger.js';

/** Parses an NDJSON response body (one JSON object per line) into events. */
function parseNdjson(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe('channelApi/chatRouter — wiring (auth, rate limit, audit, NDJSON framing)', () => {
  let client: InProcessClient;
  const baseUrl = '/chat';
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
    client = createInProcessClient(app);
  });

  it('401s when no Authorization header is sent', async () => {
    const res = await client.fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 401);
  });

  it('401s for an unknown API key', async () => {
    const res = await client.fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer omk_not-a-real-key' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 401);
  });

  it('streams an NDJSON turn end-to-end for a valid key, and audits the call', async () => {
    const created = await apiKeys.create({ label: 'streamer' });
    const before = (await auditLog.list()).length;

    const res = await client.fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'ping', conversationId: 'conv-1' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);

    // #647 — AI-Act Art. 50 provenance at the connection level: header set at
    // stream-open. Read back off the actual response, not the router input.
    assert.equal(res.headers.get(AI_PROVENANCE_HEADER), 'true');

    const events = parseNdjson(await res.text());
    assert.deepEqual(
      events.map((e) => (e as { type: string }).type),
      ['agent_bound', 'text_delta', 'done'],
    );

    // #647 — and per turn: the marker rides the `done` event. Asserted out of
    // the parsed NDJSON (the produced artifact), so a client can evaluate
    // provenance per turn and not only per connection.
    const done = events.find((e) => (e as { type: string }).type === 'done') as {
      provenance?: unknown;
    };
    assert.deepEqual(done.provenance, ENVELOPE_PROVENANCE);

    assert.equal(capturedTurns.length, 1);
    assert.equal(capturedTurns[0]?.channelId, '@omadia/channel-api');
    // Namespaced by key identity (cross-key isolation fix) — never the raw
    // caller-supplied conversationId on its own, and derived via a hash (not
    // plain concatenation) so it can't collide after downstream sanitization
    // (see the `internalConversationId` doc comment).
    assert.equal(
      capturedTurns[0]?.conversationId,
      internalConversationId(created.record.id, 'conv-1'),
    );
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
    const first = await client.fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(first.status, 200);

    await apiKeys.revoke(created.record.id);

    const second = await client.fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'hi again' }),
    });
    assert.equal(second.status, 401);
  });

  it('429s once a key exceeds its configured rate limit', async () => {
    const created = await apiKeys.create({ label: 'limited', rateLimitPerMinute: 1 });
    const first = await client.fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'one' }),
    });
    assert.equal(first.status, 200);

    const second = await client.fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'two' }),
    });
    assert.equal(second.status, 429);
  });

  it('400s on an empty message', async () => {
    const created = await apiKeys.create({ label: 'validator' });
    const res = await client.fetch(baseUrl, {
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
  client: InProcessClient;
  apiKeys: ReturnType<typeof createApiKeyStore>;
  auditLog: ReturnType<typeof createAuditLog>;
} {
  const secrets = createFakeSecrets();
  const apiKeys = createApiKeyStore(secrets);
  const auditLog = createAuditLog(secrets);
  const rateLimiter = createRateLimiter();

  const app = express();
  app.use(express.json());
  app.use(createApiChatRouter({ channelId: '@omadia/channel-api', apiKeys, auditLog, rateLimiter, core }));
  return { client: createInProcessClient(app), apiKeys, auditLog };
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

    await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA.token}` },
      body: JSON.stringify({ message: 'hi from A', conversationId: 'shared-thread' }),
    });
    await harness.client.fetch('/chat', {
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
    assert.equal(
      capturedTurns[0]?.conversationId,
      internalConversationId(keyA.record.id, 'shared-thread'),
    );
    assert.equal(
      capturedTurns[1]?.conversationId,
      internalConversationId(keyB.record.id, 'shared-thread'),
    );
  });
});

describe('channelApi/chatRouter — same-key conversationId collision via lossy sanitizeScope (finding #3)', () => {
  it('two caller-supplied conversationIds differing only in punctuation never collide after sanitizeScope', async () => {
    const capturedTurns: IncomingTurn[] = [];
    const harness = startTestServer({
      async *handleTurnStream(turn) {
        capturedTurns.push(turn);
        yield { type: 'done', answer: 'ok', toolCalls: 0, iterations: 1 };
      },
    });

    const key = await harness.apiKeys.create({ label: 'punctuation' });

    await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ message: 'hi', conversationId: 'case/a' }),
    });
    await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ message: 'hi', conversationId: 'case?a' }),
    });

    assert.equal(capturedTurns.length, 2);
    const idA = capturedTurns[0]?.conversationId ?? '';
    const idB = capturedTurns[1]?.conversationId ?? '';
    // The internal conversationIds themselves must differ...
    assert.notEqual(idA, idB);
    // ...and, critically, so must the scope SessionLogger actually persists
    // under (`graphScopeFor` applies the real `sanitizeScope`, which lower-
    // cases and collapses any punctuation run to a single '-' — the exact
    // transform that made `"case/a"` and `"case?a"` collide before this fix,
    // since plain concatenation left that punctuation exposed).
    assert.notEqual(graphScopeFor(undefined, idA), graphScopeFor(undefined, idB));
  });

  it('two long caller-supplied conversationIds differing only past the 80-char sanitizeScope truncation cutoff never collide', async () => {
    const capturedTurns: IncomingTurn[] = [];
    const harness = startTestServer({
      async *handleTurnStream(turn) {
        capturedTurns.push(turn);
        yield { type: 'done', answer: 'ok', toolCalls: 0, iterations: 1 };
      },
    });

    const key = await harness.apiKeys.create({ label: 'truncation' });
    // Well past 80 chars post-sanitization once namespaced with a key id —
    // these two only diverge after the point sanitizeScope would truncate a
    // plain-concatenated scope, which is exactly what made them collide
    // before this fix.
    const longBase = 'x'.repeat(150);

    await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ message: 'hi', conversationId: `${longBase}-tail-one` }),
    });
    await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ message: 'hi', conversationId: `${longBase}-tail-two` }),
    });

    assert.equal(capturedTurns.length, 2);
    const idA = capturedTurns[0]?.conversationId ?? '';
    const idB = capturedTurns[1]?.conversationId ?? '';
    assert.notEqual(idA, idB);
    assert.notEqual(graphScopeFor(undefined, idA), graphScopeFor(undefined, idB));
  });
});

describe('channelApi/chatRouter — audit-log accuracy for every authenticated outcome (finding #2)', () => {
  it('does NOT audit an unauthenticated call (missing key)', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        yield { type: 'done', answer: 'x', toolCalls: 0, iterations: 1 };
      },
    });

    const res = await harness.client.fetch('/chat', {
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
  });

  it('audits status "rate_limited" for an authenticated call over quota — never "ok"', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        yield { type: 'done', answer: 'x', toolCalls: 0, iterations: 1 };
      },
    });
    const created = await harness.apiKeys.create({ label: 'quota', rateLimitPerMinute: 1 });

    await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'one' }),
    });
    const res = await harness.client.fetch('/chat', {
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
  });

  it('audits status "invalid_request" for a schema-invalid body — never "ok"', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        yield { type: 'done', answer: 'x', toolCalls: 0, iterations: 1 };
      },
    });
    const created = await harness.apiKeys.create({ label: 'validator' });

    const res = await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: '' }),
    });
    assert.equal(res.status, 400);

    const entries = await harness.auditLog.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, 'invalid_request');
  });

  it('audits status "error" — never "ok" — when the orchestrator throws mid-turn', async () => {
    const harness = startTestServer({
      async *handleTurnStream() {
        await Promise.resolve();
        throw new Error('orchestrator exploded');
      },
    });
    const created = await harness.apiKeys.create({ label: 'crasher' });

    const res = await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    // Headers are already flushed (200) before dispatch starts — the error
    // surfaces as an NDJSON event on the wire, not an HTTP error status.
    assert.equal(res.status, 200);
    // #647 acceptance criterion — "auch bei einem mid-turn throw": the header is
    // set at stream-open, before dispatch, so it is on the wire regardless of a
    // throw inside `handleTurnStream`. No `done` is emitted on this path, so the
    // header is the sole carrier. Read back off the actual response.
    assert.equal(res.headers.get(AI_PROVENANCE_HEADER), 'true');
    const body = await res.text();
    assert.ok(body.includes('orchestrator exploded'));
    assert.equal(
      parseNdjson(body).some((e) => (e as { type: string }).type === 'done'),
      false,
      'no done event on the mid-turn-throw path — the header is the only carrier',
    );

    const entries = await harness.auditLog.list();
    assert.equal(entries.length, 1, 'exactly one audit row for this authenticated call');
    assert.equal(
      entries[0]?.status,
      'error',
      'a mid-turn throw must be audited as "error", not optimistically as "ok"',
    );
  });

  it('audits status "error" — never "ok" — for an in-band {type:"error"} event with no throw', async () => {
    // The real orchestrator (and the verifier-wrapped orchestrator, when
    // verifier mode is on) can yield a `{type:'error', message}` event on an
    // already-open 200 stream WITHOUT throwing — the async iterator
    // completes normally. This is the exact bug class that hit issue #403:
    // nothing throws, so a naive "loop completed => audit ok" is wrong.
    const harness = startTestServer({
      async *handleTurnStream() {
        yield { type: 'text_delta', text: 'partial answer before things went wrong' };
        yield { type: 'error', message: 'downstream tool call failed' };
      },
    });
    const created = await harness.apiKeys.create({ label: 'in-band-error' });

    const res = await harness.client.fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 200);
    // #647 acceptance criterion: the provenance marking is present even when the
    // turn ends in-band with `{type:'error'}`. No `done` event is emitted on
    // that path, so the carrier is the response header — set at stream-open,
    // before dispatch, which is why it survives an error-ending turn.
    assert.equal(res.headers.get(AI_PROVENANCE_HEADER), 'true');
    const events = parseNdjson(await res.text());
    assert.deepEqual(
      events.map((e) => (e as { type: string }).type),
      ['text_delta', 'error'],
    );
    assert.equal(
      events.some((e) => (e as { type: string }).type === 'done'),
      false,
      'no done event on the in-band-error path — the header is the only carrier',
    );

    const entries = await harness.auditLog.list();
    assert.equal(entries.length, 1, 'exactly one audit row for this authenticated call');
    assert.equal(
      entries[0]?.status,
      'error',
      'an in-band error event with no throw must be audited as "error", not "ok"',
    );
  });
});
