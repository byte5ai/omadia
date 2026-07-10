import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import {
  createLlmProxyRouter,
  type LlmModelPolicy,
  type LlmProxyDeps,
  type LlmProxyJob,
  type LlmProxyUsageRecord,
} from '../../src/devplatform/llmProxy.js';
import { createDevRunnerRouter, type DevRunnerRouterDeps } from '../../src/routes/devRunnerApi.js';
import type { DevJobStatus } from '../../src/devplatform/types.js';

/**
 * Epic #470 W1 — the LLM proxy (spec §6b). The spec names no unit test for this
 * unit; this file covers every acceptance criterion: mount on the phone-home
 * router + terminal 410, the `GET /` probe, job-token→provider-key swap with
 * header stripping, the model allowlist 403, verbatim SSE passthrough with usage
 * metering into dev_jobs + the ledger, 429 Retry-After passthrough, 5xx
 * single-retry, and the no-retry-after-tokens-emitted rule.
 */

const VALID = 'djr_valid-token';
const REAL_KEY = 'sk-ant-REAL-PROVIDER-KEY';
const CLIENT_KEY = 'sk-ant-CLIENT-SUPPLIED-DO-NOT-FORWARD';

// --- SSE fixtures (Anthropic Messages streaming shape) ----------------------
const SSE_START =
  'event: message_start\n' +
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":5,"cache_creation_input_tokens":0}}}\n\n';
const SSE_DELTA =
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n';
const SSE_MSG_DELTA =
  'event: message_delta\n' +
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n';
const SSE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const FULL_SSE = SSE_START + SSE_DELTA + SSE_MSG_DELTA + SSE_STOP;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A recorded upstream call, for header/body/count assertions. */
interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function sseResponse(text: string, opts: { truncateAfterBytes?: number } = {}): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  // Pull-based delivery: on truncation the first pull hands over the partial
  // chunk (consumed before the next pull), then the second pull errors the
  // stream. `controller.error()` discards *queued* chunks, so a single-`start`
  // enqueue-then-error would deliver nothing — the two-stage pull avoids that.
  let stage = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.truncateAfterBytes !== undefined) {
        if (stage === 0) {
          stage = 1;
          controller.enqueue(bytes.slice(0, opts.truncateAfterBytes));
        } else {
          controller.error(new Error('upstream connection reset'));
        }
        return;
      }
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Fixture {
  server: Server;
  base: string; // …/api/v1/dev-runner
  calls: FetchCall[];
  usageRows: LlmProxyUsageRecord[];
  jobUsage: Array<{ jobId: string; tokensIn: number; tokensOut: number }>;
  metered: Deferred<void>;
  close(): Promise<void>;
}

function makeFixture(opts: {
  job?: LlmProxyJob | null;
  policy?: LlmModelPolicy | null;
  providerKey?: string | undefined;
  upstream: (call: FetchCall, attempt: number) => Response | Promise<Response> | never;
  proxyOverrides?: Partial<LlmProxyDeps>;
}): Promise<Fixture> {
  const calls: FetchCall[] = [];
  const usageRows: LlmProxyUsageRecord[] = [];
  const jobUsage: Fixture['jobUsage'] = [];
  const metered = deferred<void>();

  const job: LlmProxyJob | null =
    opts.job === undefined ? { id: 'job-1', status: 'running', agentKind: 'claude-cli' } : opts.job;
  const policy: LlmModelPolicy | null =
    opts.policy === undefined
      ? { provider: 'anthropic', upstreamBaseUrl: 'https://upstream.test', allowedModels: ['claude-opus-4-8'] }
      : opts.policy;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string>;
    const body = init?.body instanceof Buffer ? init.body.toString('utf8') : String(init?.body ?? '');
    const call: FetchCall = { url: String(url), headers: { ...headers }, body };
    const attempt = calls.length;
    calls.push(call);
    return opts.upstream(call, attempt);
  }) as unknown as typeof fetch;

  const proxyDeps: LlmProxyDeps = {
    resolveJobByToken: async (t) => (t === VALID ? job : null),
    resolvePolicy: async () => policy,
    resolveProviderKey: async () => (opts.providerKey === undefined ? REAL_KEY : opts.providerKey),
    addJobUsage: async (jobId, tokensIn, tokensOut) => {
      jobUsage.push({ jobId, tokensIn, tokensOut });
    },
    recordUsage: (row) => {
      usageRows.push(row);
      metered.resolve();
    },
    fetchImpl,
    ...opts.proxyOverrides,
  };

  const app: Express = express();
  const runnerDeps: DevRunnerRouterDeps = {
    store: {
      verifyRunnerToken: async () => false,
      getJob: async () => null,
      markRunning: async () => false,
      touchHeartbeat: async () => false,
      appendEvents: async () => 0,
      addArtifact: async () => 'x',
      artifactBelongsToJob: async () => false,
      recordResult: async () => {},
    },
    repos: { getRepo: async () => null },
    scmTokens: { resolve: async () => undefined },
    finalizeDevJob: async () => null,
    llmProxyRouter: createLlmProxyRouter(proxyDeps),
  };
  app.use('/api/v1/dev-runner', createDevRunnerRouter(runnerDeps));

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        base: `http://127.0.0.1:${String(port)}/api/v1/dev-runner`,
        calls,
        usageRows,
        jobUsage,
        metered,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function post(base: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}/llm/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const authed = { authorization: `Bearer ${VALID}` };
const OK_BODY = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }], stream: true };

describe('llmProxy — mount + auth gate', () => {
  let fx: Fixture;
  afterEach(async () => {
    if (fx) await fx.close();
  });

  it('GET / (proxy origin root) returns 2xx for the CLI probe', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await fetch(`${fx.base}/llm/`);
    assert.equal(res.status, 200);
    await res.text();
  });

  it('401 with no bearer', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await post(fx.base, OK_BODY, {});
    assert.equal(res.status, 401);
    assert.equal(fx.calls.length, 0);
  });

  it('401 with an unknown bearer (no oracle)', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await post(fx.base, OK_BODY, { authorization: 'Bearer djr_nope' });
    assert.equal(res.status, 401);
    assert.equal(fx.calls.length, 0);
  });

  it('410 for a terminal job', async () => {
    fx = await makeFixture({
      job: { id: 'job-1', status: 'done' as DevJobStatus, agentKind: 'claude-cli' },
      upstream: () => sseResponse(FULL_SSE),
    });
    const res = await post(fx.base, OK_BODY, authed);
    assert.equal(res.status, 410);
    assert.equal(((await res.json()) as { code: string }).code, 'devplatform.job_terminal');
    assert.equal(fx.calls.length, 0);
  });
});

describe('llmProxy — key swap + header stripping', () => {
  let fx: Fixture;
  afterEach(async () => {
    if (fx) await fx.close();
  });

  it('replaces the client bearer with the Vault provider key and strips client x-api-key/authorization', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await post(fx.base, OK_BODY, { ...authed, 'x-api-key': CLIENT_KEY });
    await res.text();

    assert.equal(fx.calls.length, 1);
    const fwd = fx.calls[0]!.headers;
    // provider key attached; no client key survives anywhere.
    assert.equal(fwd['x-api-key'], REAL_KEY);
    const serialized = JSON.stringify(fwd);
    assert.ok(!serialized.includes(CLIENT_KEY), 'client x-api-key must not be forwarded');
    assert.ok(!serialized.includes(VALID), 'job bearer must not be forwarded');
    // no Authorization header reaches upstream.
    assert.ok(!Object.keys(fwd).some((k) => k.toLowerCase() === 'authorization'));
  });

  it('preserves the ?beta=true query when forwarding', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await post(fx.base, OK_BODY, authed);
    await res.text();
    assert.ok(fx.calls[0]!.url.endsWith('/v1/messages?beta=true'), fx.calls[0]!.url);
  });

  it('500 when no provider key is configured; nothing is forwarded upstream', async () => {
    fx = await makeFixture({
      proxyOverrides: { resolveProviderKey: async () => undefined },
      upstream: () => sseResponse(FULL_SSE),
    });
    const res = await post(fx.base, OK_BODY, authed);
    assert.equal(res.status, 500);
    assert.equal(fx.calls.length, 0);
  });
});

describe('llmProxy — model allowlist', () => {
  let fx: Fixture;
  afterEach(async () => {
    if (fx) await fx.close();
  });

  it('403 dev.model_not_allowed for a model outside the allowlist', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await post(fx.base, { ...OK_BODY, model: 'claude-forbidden' }, authed);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'dev.model_not_allowed');
    assert.equal(fx.calls.length, 0);
  });

  it('400 when the body names no model', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await post(fx.base, { messages: [] }, authed);
    assert.equal(res.status, 400);
    assert.equal(fx.calls.length, 0);
  });
});

describe('llmProxy — SSE passthrough + usage metering', () => {
  let fx: Fixture;
  afterEach(async () => {
    if (fx) await fx.close();
  });

  it('streams the response verbatim and meters usage into dev_jobs + the ledger', async () => {
    fx = await makeFixture({ upstream: () => sseResponse(FULL_SSE) });
    const res = await post(fx.base, OK_BODY, authed);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    assert.equal(text, FULL_SSE, 'body must pass through byte-for-byte');

    await fx.metered.promise;
    // dev_jobs.tokens_in = input + cache_read + cache_creation = 10 + 5 + 0
    assert.deepEqual(fx.jobUsage, [{ jobId: 'job-1', tokensIn: 15, tokensOut: 20 }]);
    assert.equal(fx.usageRows.length, 1);
    const row = fx.usageRows[0]!;
    assert.equal(row.source, 'dev-job');
    assert.equal(row.sessionId, 'devjob:job-1');
    assert.equal(row.model, 'claude-opus-4-8');
    assert.equal(row.inputTokens, 10);
    assert.equal(row.outputTokens, 20);
    assert.equal(row.cacheReadTokens, 5);
  });

  it('meters usage from a non-streamed JSON response body', async () => {
    fx = await makeFixture({
      upstream: () =>
        new Response(
          JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 2 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const res = await post(fx.base, { ...OK_BODY, stream: false }, authed);
    await res.text();
    await fx.metered.promise;
    assert.deepEqual(fx.jobUsage, [{ jobId: 'job-1', tokensIn: 9, tokensOut: 3 }]);
  });
});

describe('llmProxy — failure semantics', () => {
  let fx: Fixture;
  afterEach(async () => {
    if (fx) await fx.close();
  });

  it('passes a 429 through with Retry-After and does not retry', async () => {
    fx = await makeFixture({
      upstream: () =>
        new Response('{"type":"error"}', {
          status: 429,
          headers: { 'retry-after': '42', 'content-type': 'application/json' },
        }),
    });
    const res = await post(fx.base, OK_BODY, authed);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '42');
    await res.text();
    assert.equal(fx.calls.length, 1, '429 must not be retried');
  });

  it('retries a 5xx exactly once, then succeeds', async () => {
    fx = await makeFixture({
      upstream: (_c, attempt) =>
        attempt === 0
          ? new Response('{"type":"error"}', { status: 503, headers: { 'content-type': 'application/json' } })
          : sseResponse(FULL_SSE),
    });
    const res = await post(fx.base, OK_BODY, authed);
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(fx.calls.length, 2, '5xx must be retried exactly once');
  });

  it('never retries a streamed request that already emitted tokens (no double-billing)', async () => {
    // A 200 whose body dies mid-stream: tokens already reached the client, so the
    // proxy must NOT re-issue the request — it records the partial usage instead.
    fx = await makeFixture({
      upstream: () => sseResponse(FULL_SSE, { truncateAfterBytes: SSE_START.length }),
    });
    const res = await post(fx.base, OK_BODY, authed);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.startsWith('event: message_start'), 'partial bytes reached the client');
    await fx.metered.promise;
    assert.equal(fx.calls.length, 1, 'a request that emitted tokens is never retried');
    // partial usage from message_start only (input 10 + cache_read 5, output 1).
    assert.deepEqual(fx.jobUsage, [{ jobId: 'job-1', tokensIn: 15, tokensOut: 1 }]);
  });
});
