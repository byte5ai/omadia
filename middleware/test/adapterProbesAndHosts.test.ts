/**
 * #1974 — Web Search and the OpenAI transcription adapter export a
 * connection probe and report a missing key as "not configured".
 * #1984 / ADR-0200 — the OpenAI adapters send only to declared hosts:
 * api.openai.com plus the operator's `allowed_hosts`.
 */

import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import type { PluginActionStatus, PluginContext } from '@omadia/plugin-api';
import { activate as activateEmbeddings } from '@omadia/embedding-adapter-openai/dist/plugin.js';
import {
  activate as activateWebSearch,
  verifyConnection as verifyWebSearch,
} from '@omadia/plugin-web-search';
import {
  activate as activateTranscription,
  parseAllowedHosts,
  probeOpenAiKey,
  undeclaredHost,
} from '@omadia/transcription-adapter-openai';

interface FakeCtx {
  readonly ctx: PluginContext;
  readonly statuses: PluginActionStatus[];
  readonly provided: string[];
}

function fakeCtx(opts: {
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  httpFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): FakeCtx {
  const statuses: PluginActionStatus[] = [];
  const provided: string[] = [];
  const ctx = {
    log: () => undefined,
    config: { get: (key: string) => opts.config?.[key] },
    secrets: { get: (key: string) => Promise.resolve(opts.secrets?.[key]) },
    status: {
      report: (s: PluginActionStatus) => statuses.push(s),
      clear: () => statuses.push({ state: 'ok' }),
    },
    services: {
      get: () => undefined,
      getOptional: () => undefined,
      provide: (name: string) => {
        provided.push(name);
        return () => undefined;
      },
    },
    tools: { register: () => () => undefined },
    ...(opts.httpFetch ? { http: { fetch: opts.httpFetch } } : {}),
  } as unknown as PluginContext;
  return { ctx, statuses, provided };
}

describe('#1984 — declared hosts of the OpenAI adapters', () => {
  it('api.openai.com is declared; any other host only through allowed_hosts', () => {
    assert.equal(undeclaredHost('https://api.openai.com/v1', []), undefined);
    assert.equal(undeclaredHost('http://host.docker.internal:8799', []), 'host.docker.internal');
    const allowed = parseAllowedHosts('my.azure.example, https://llm.internal:8443/v1');
    assert.deepEqual(allowed, ['my.azure.example', 'llm.internal']);
    assert.equal(undeclaredHost('https://llm.internal:8443/v1', allowed), undefined);
  });

  it('transcription refuses an undeclared Base URL: no service, status error', async () => {
    const { ctx, statuses, provided } = fakeCtx({
      config: { base_url: 'http://host.docker.internal:8799' },
      secrets: { api_key: 'sk-test' },
    });
    await activateTranscription(ctx);
    assert.deepEqual(provided, []);
    assert.equal(statuses.at(-1)?.state, 'error');
  });

  it('embeddings refuse an undeclared Base URL and accept it once allowed', async () => {
    const refused = fakeCtx({
      config: { base_url: 'http://ollama:11434', model: 'nomic-embed-text', dimensions: 768 },
      secrets: { api_key: 'k' },
    });
    await activateEmbeddings(refused.ctx);
    assert.deepEqual(refused.provided, []);
    assert.equal(refused.statuses.at(-1)?.state, 'error');

    const allowed = fakeCtx({
      config: {
        base_url: 'http://ollama:11434',
        allowed_hosts: 'ollama',
        model: 'nomic-embed-text',
        dimensions: 768,
      },
      secrets: { api_key: 'k' },
    });
    await activateEmbeddings(allowed.ctx);
    assert.deepEqual(allowed.provided, ['embeddingClient']);
  });
});

describe('#1974 — missing keys read as "not configured"', () => {
  it('transcription without a key reports needs_action', async () => {
    const { ctx, statuses, provided } = fakeCtx({});
    await activateTranscription(ctx);
    assert.deepEqual(provided, []);
    assert.equal(statuses.at(-1)?.state, 'needs_action');
  });

  it('web search without the selected provider key reports needs_action', async () => {
    const { ctx, statuses } = fakeCtx({
      config: { provider: 'tavily' },
      httpFetch: () => Promise.resolve(new Response('{}')),
    });
    await activateWebSearch(ctx);
    assert.equal(statuses.at(-1)?.state, 'needs_action');
  });
});

describe('#1974 — connection probes', () => {
  it('web search: 401 rejects, 2xx connects, 5xx stays inconclusive', async () => {
    const withStatus = (status: number) =>
      fakeCtx({
        config: { provider: 'brave' },
        secrets: { brave_api_key: 'k' },
        httpFetch: () => Promise.resolve(new Response('{}', { status })),
      }).ctx;
    assert.deepEqual(
      { ...(await verifyWebSearch(withStatus(401))), title: undefined, detail: undefined },
      { status: 'rejected', cause: 'http_401', title: undefined, detail: undefined },
    );
    assert.equal((await verifyWebSearch(withStatus(200))).status, 'connected');
    assert.equal((await verifyWebSearch(withStatus(503))).status, 'inconclusive');
  });

  let server: Server;
  let baseUrl = '';
  let answer = 200;
  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(req.url === '/v1/models' ? answer : 404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('transcription: GET /v1/models 401 rejects, 200 connects', async () => {
    answer = 401;
    const rejected = await probeOpenAiKey(`${baseUrl}/v1`, 'sk-bad');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.cause, 'http_401');
    answer = 200;
    assert.equal((await probeOpenAiKey(baseUrl, 'sk-good')).status, 'connected');
  });
});
