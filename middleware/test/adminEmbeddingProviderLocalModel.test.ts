import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import {
  createAdminEmbeddingProviderRouter,
  type AdminEmbeddingProviderDeps,
  type LocalEmbeddingModelFetcher,
} from '../src/routes/adminEmbeddingProvider.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

/**
 * `GET /local-model` and `POST /local-model/fetch` (OM-84 follow-up).
 *
 * Its own tiny app rather than the shared `adminEmbeddingProvider.harness.ts`:
 * these two routes touch none of the corpus/gate machinery that harness exists
 * to model, and teaching it a fetcher would have meant changing a file three
 * other specs depend on for a feature none of them exercise.
 *
 * The fetcher is a fake with an explicit state, because the thing under test is
 * the ROUTE's contract — which status code means what — and the real fetcher's
 * behaviour is pinned next door in `localEmbeddingModelFetch.test.ts`.
 */

let server: Server;
let baseUrl: string;
let fetcher: LocalEmbeddingModelFetcher | undefined;
let startResult = true;
let startCalls = 0;

function status(missing: readonly string[], state: 'idle' | 'running' | 'done' | 'failed', error: string | null = null) {
  return {
    modelDir: '/var/embedding-models',
    missingFiles: missing,
    totalBytes: 135_392_208,
    job: {
      state,
      downloadedBytes: state === 'done' ? 135_392_208 : 0,
      totalBytes: 135_392_208,
      currentFile: state === 'running' ? 'onnx/model_quantized.onnx' : null,
      error,
    },
  };
}

function fakeFetcher(
  missing: readonly string[],
  state: 'idle' | 'running' | 'done' | 'failed' = 'idle',
  error: string | null = null,
): LocalEmbeddingModelFetcher {
  return {
    status: () => status(missing, state, error),
    start: () => {
      startCalls += 1;
      return startResult;
    },
  };
}

before(async () => {
  const deps = {
    installedRegistry: new InMemoryInstalledRegistry(),
    catalog: { list: () => [], get: () => undefined },
    getEmbeddingClient: () => undefined,
    getLocalModelFetcher: () => fetcher,
    getGateStatus: () => undefined,
    getGraphPool: () => undefined,
    tenantId: 'default',
    activate: async () => {},
    deactivate: async () => true,
  } as unknown as AdminEmbeddingProviderDeps;

  const app = express();
  app.use(express.json());
  app.use('/', createAdminEmbeddingProviderRouter(deps));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /local-model', () => {
  it('404s when the keyless adapter is not active', async () => {
    fetcher = undefined;
    const res = await get('/local-model');
    // Not an empty 200: "there is no keyless provider here" and "its weights
    // are missing" are different answers and the page reacts differently — a
    // keyed deployment must render no button and no error at all.
    assert.equal(res.status, 404);
    assert.equal(res.body['code'], 'embeddingProvider.local_model_unavailable');
  });

  it('reports the missing files and the download size', async () => {
    fetcher = fakeFetcher(['onnx/model_quantized.onnx']);
    const res = await get('/local-model');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body['missingFiles'], ['onnx/model_quantized.onnx']);
    assert.equal(res.body['totalBytes'], 135_392_208);
    assert.equal(res.body['modelDir'], '/var/embedding-models');
  });

  it('passes a failure message through so the page can show it', async () => {
    fetcher = fakeFetcher(['config.json'], 'failed', 'GET … → HTTP 503');
    const res = await get('/local-model');
    const job = res.body['job'] as Record<string, unknown>;
    assert.equal(job['state'], 'failed');
    assert.equal(job['error'], 'GET … → HTTP 503');
  });
});

describe('POST /local-model/fetch', () => {
  it('404s when the keyless adapter is not active', async () => {
    fetcher = undefined;
    const res = await post('/local-model/fetch');
    assert.equal(res.status, 404);
    assert.equal(res.body['code'], 'embeddingProvider.local_model_unavailable');
  });

  it('answers 202 and starts the run', async () => {
    fetcher = fakeFetcher(['onnx/model_quantized.onnx']);
    startResult = true;
    startCalls = 0;

    const res = await post('/local-model/fetch');

    // 202, not 200: the download moves ~135 MB and takes minutes. Holding the
    // request open would time out behind a proxy, which is indistinguishable
    // from a broken download.
    assert.equal(res.status, 202);
    assert.equal(res.body['started'], true);
    assert.equal(startCalls, 1);
  });

  it('answers 409 on a second click while one is running', async () => {
    fetcher = fakeFetcher(['onnx/model_quantized.onnx'], 'running');
    startResult = false;
    startCalls = 0;

    const res = await post('/local-model/fetch');

    // Two runs would write the same `.partial` paths and race the renames.
    assert.equal(res.status, 409);
    assert.equal(res.body['code'], 'embeddingProvider.local_model_busy');
    assert.equal(startCalls, 1, 'the route asks the fetcher, it does not guess');
    // The busy answer still carries the progress, so the page has something
    // to show instead of only an error.
    assert.ok(res.body['job']);
  });

  it('does not start a run when nothing is missing', async () => {
    fetcher = fakeFetcher([], 'idle');
    startCalls = 0;

    const res = await post('/local-model/fetch');

    // A 202 that resolves instantly would leave the operator wondering
    // whether anything happened at all.
    assert.equal(res.status, 200);
    assert.equal(res.body['started'], false);
    assert.equal(res.body['reason'], 'already-complete');
    assert.equal(startCalls, 0, 'must not touch the network when complete');
  });
});
