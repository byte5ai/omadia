import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import {
  createOpenAiEmbeddingClient,
  defaultDimensionsForModel,
} from '@omadia/embedding-adapter-openai/dist/openaiEmbeddingClient.js';

// A real loopback server rather than a fetch stub: the point of these tests is
// the wire mapping (path, auth header, body shape, response parsing), and a
// stub would let a wrong URL pass unnoticed.

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  body: unknown;
}

interface Scripted {
  status: number;
  payload: unknown;
}

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let next: Scripted = { status: 200, payload: { data: [{ embedding: [1, 2, 3] }] } };

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      captured.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      });
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(overrides: { model?: string; dimensions?: number; baseUrl?: string } = {}) {
  captured = [];
  return createOpenAiEmbeddingClient({
    baseUrl: overrides.baseUrl ?? baseUrl,
    apiKey: 'test-key',
    model: overrides.model ?? 'text-embedding-3-small',
    dimensions: overrides.dimensions ?? 3,
    timeoutMs: 5_000,
  });
}

describe('createOpenAiEmbeddingClient', () => {
  it('POSTs {model, input} to /v1/embeddings with a bearer token', async () => {
    next = { status: 200, payload: { data: [{ embedding: [0.1, 0.2, 0.3] }] } };
    const c = client();

    const vector = await c.embed('hello');

    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.url, '/v1/embeddings');
    assert.equal(captured[0]?.authorization, 'Bearer test-key');
    assert.deepEqual(captured[0]?.body, {
      model: 'text-embedding-3-small',
      input: 'hello',
    });
  });

  it('reports provider metadata for the dimension gate', async () => {
    const c = client({ model: 'text-embedding-3-large', dimensions: 3072 });

    assert.equal(c.modelId, 'openai:text-embedding-3-large');
    assert.equal(c.dimensions, 3072);
  });

  it('does not duplicate /v1 when the base URL already carries it', async () => {
    next = { status: 200, payload: { data: [{ embedding: [1, 2, 3] }] } };
    const c = client({ baseUrl: `${baseUrl}/v1/` });

    await c.embed('hello');

    assert.equal(captured[0]?.url, '/v1/embeddings');
  });

  it('coerces numeric strings, which some OpenAI-compatible clones return', async () => {
    next = { status: 200, payload: { data: [{ embedding: ['0.5', 1, '-0.25'] }] } };
    const c = client();

    assert.deepEqual(await c.embed('hello'), [0.5, 1, -0.25]);
  });

  it('throws on a non-2xx response, carrying status and a truncated body', async () => {
    next = { status: 429, payload: { error: { message: 'slow down' } } };
    const c = client();

    await assert.rejects(c.embed('hello'), (err: Error & { status?: number }) => {
      assert.equal(err.name, 'EmbeddingError');
      assert.equal(err.status, 429);
      return true;
    });
  });

  it('throws when the response carries no vector', async () => {
    next = { status: 200, payload: { data: [] } };
    const c = client();

    await assert.rejects(c.embed('hello'), /no embedding vector/);
  });

  it('throws when a non-numeric entry appears in the vector', async () => {
    next = { status: 200, payload: { data: [{ embedding: [1, 'oops', 3] }] } };
    const c = client();

    await assert.rejects(c.embed('hello'), /non-numeric/);
  });

  it('rejects a vector whose length contradicts the configured dimensions', async () => {
    next = { status: 200, payload: { data: [{ embedding: [1, 2] }] } };
    const c = client({ dimensions: 3 });

    await assert.rejects(c.embed('hello'), /dimension mismatch/);
  });
});

describe('defaultDimensionsForModel', () => {
  it('knows the OpenAI embedding models', () => {
    assert.equal(defaultDimensionsForModel('text-embedding-3-small'), 1536);
    assert.equal(defaultDimensionsForModel('text-embedding-3-large'), 3072);
    assert.equal(defaultDimensionsForModel('text-embedding-ada-002'), 1536);
  });

  it('returns undefined for an unknown model so the operator must be explicit', () => {
    assert.equal(defaultDimensionsForModel('some-local-model'), undefined);
  });
});
