import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, reactivateEmbeddingProvider } from '../api';

/**
 * OM-98 / #1077 — the request wrapper behind "re-activate embedding provider".
 *
 * Every page test mocks `reactivateEmbeddingProvider` away, so its method, URL
 * and error mapping were never exercised. Here the REAL module runs against a
 * stubbed `fetch` (browser side, so the `/bot-api` proxy path applies): a
 * changed route, a GET instead of a POST, or a dropped session cookie would
 * all reach the middleware as a 404/401 in production — this is where they go
 * red instead.
 */

const fetchMock = vi.fn();

function respond(status: number, body: unknown): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

describe('reactivateEmbeddingProvider (OM-98)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs an empty JSON body to the reactivate route with the session cookie', async () => {
    const result = {
      ok: true,
      reactivated: '@omadia/embeddings',
      gateReevaluated: true,
      dedupThreshold: null,
    };
    respond(200, result);

    await expect(reactivateEmbeddingProvider()).resolves.toMatchObject(result);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/bot-api/v1/admin/embedding-provider/reactivate');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('surfaces a refusal as an ApiError carrying the status and the machine code', async () => {
    respond(409, {
      code: 'embeddingProvider.corpus_not_empty',
      message: 'corpus is not empty',
    });

    const err = await reactivateEmbeddingProvider().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('embeddingProvider.corpus_not_empty');
  });

  it('keeps a server failure distinct from a refusal', async () => {
    respond(500, { code: 'embeddingProvider.reactivate_failed' });
    const err = await reactivateEmbeddingProvider().catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe('embeddingProvider.reactivate_failed');
  });
});
