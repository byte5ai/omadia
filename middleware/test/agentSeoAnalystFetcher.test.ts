import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { HttpAccessor } from '@omadia/plugin-api';

import { createFetcher } from '../packages/agent-seo-analyst/fetcher.js';

/**
 * #91 — agent-seo-analyst routes every request through `ctx.http` (no raw
 * global fetch) and surfaces a permission rejection as `FetchResult.blocked`
 * so the toolkit can report honestly instead of silently substituting a URL.
 */

const noopLog = (): void => {};

function fetcherWith(http: HttpAccessor): ReturnType<typeof createFetcher> {
  return createFetcher({ userAgent: 'ua', timeoutMs: 5000, log: noopLog, http });
}

describe('agent-seo-analyst fetcher — #91 ctx.http migration', () => {
  it('routes requests through ctx.http and returns a normal result', async () => {
    const seen: string[] = [];
    const fetcher = fetcherWith({
      async fetch(url: string): Promise<Response> {
        seen.push(url);
        return new Response('<html><head><title>Hi</title></head></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    const res = await fetcher.get('https://omadia.ai/');
    assert.deepEqual(seen, ['https://omadia.ai/']);
    assert.equal(res.status, 200);
    assert.equal(res.blocked, undefined);
  });

  it('surfaces a permission rejection as `blocked`', async () => {
    const fetcher = fetcherWith({
      async fetch(): Promise<Response> {
        const err = new Error(
          "plugin 'x' is not permitted to reach 'wikipedia.org'",
        );
        err.name = 'HttpForbiddenError';
        throw err;
      },
    });
    const res = await fetcher.get('https://wikipedia.org/');
    assert.equal(res.status, 0);
    assert.ok(res.blocked?.includes('not permitted to reach'));
  });

  it('treats a generic network error as a plain failure (no `blocked`)', async () => {
    const fetcher = fetcherWith({
      async fetch(): Promise<Response> {
        throw new Error('ECONNRESET');
      },
    });
    const res = await fetcher.get('https://omadia.ai/');
    assert.equal(res.status, 0);
    assert.equal(res.blocked, undefined);
  });
});
