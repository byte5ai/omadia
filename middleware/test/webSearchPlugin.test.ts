import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  searchToolSpec,
  WEB_SEARCH_TOOL_NAME,
  WebSearchAuthError,
  WebSearchProviderError,
  WebSearchQuotaError,
} from '@omadia/plugin-web-search';
import { TtlLruCache } from '@omadia/plugin-web-search/dist/cache.js';
import { createBraveProvider } from '@omadia/plugin-web-search/dist/providers/brave.js';
import { createProvider } from '@omadia/plugin-web-search/dist/providers/registry.js';
import { createTavilyProvider } from '@omadia/plugin-web-search/dist/providers/tavily.js';
import { createWebSearchService } from '@omadia/plugin-web-search/dist/searchService.js';
import { createWebSearchToolHandler } from '@omadia/plugin-web-search/dist/searchTool.js';
import type { SearchResponse } from '@omadia/plugin-web-search';

/**
 * Unit tests for the web-search plugin. Providers are tested with a mock
 * fetch that captures the request shape (URL, method, headers, body) and
 * returns canned responses for each scenario. No network access required.
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function makeMockFetch(
  responder: (call: CapturedCall) => { status: number; body: unknown },
): { fetch: FetchFn; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k] ?? '';
    }
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body !== undefined && init.body !== null
          ? String(init.body)
          : null;
    const call: CapturedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body,
    };
    calls.push(call);
    const { status, body: respBody } = responder(call);
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchFn, calls };
}

describe('TtlLruCache', () => {
  it('returns undefined for missing keys', () => {
    const cache = new TtlLruCache<string>(10, 1000);
    assert.equal(cache.get('foo'), undefined);
  });

  it('round-trips set/get within TTL', () => {
    const cache = new TtlLruCache<string>(10, 1000);
    const now = 100;
    cache.set('foo', 'bar', undefined, now);
    assert.equal(cache.get('foo', now + 500), 'bar');
  });

  it('expires entries past TTL', () => {
    const cache = new TtlLruCache<string>(10, 1000);
    const now = 100;
    cache.set('foo', 'bar', undefined, now);
    assert.equal(cache.get('foo', now + 1500), undefined);
  });

  it('evicts oldest entry when over maxEntries', () => {
    const cache = new TtlLruCache<string>(2, 10_000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3'); // evicts 'a'
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), '2');
    assert.equal(cache.get('c'), '3');
  });

  it('refreshes LRU position on get', () => {
    const cache = new TtlLruCache<string>(2, 10_000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a'); // makes 'a' the most-recent
    cache.set('c', '3'); // should evict 'b' now
    assert.equal(cache.get('a'), '1');
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('c'), '3');
  });

  it('throws on non-positive maxEntries / TTL', () => {
    assert.throws(() => new TtlLruCache(0, 1000));
    assert.throws(() => new TtlLruCache(10, 0));
  });
});

describe('createTavilyProvider', () => {
  it('posts to /search with bearer auth and parses results', async () => {
    const { fetch, calls } = makeMockFetch(() => ({
      status: 200,
      body: {
        results: [
          {
            title: 'Test result',
            url: 'https://example.com/x',
            content: 'snippet text',
            score: 0.9,
            published_date: '2026-05-01',
          },
        ],
      },
    }));
    const provider = createTavilyProvider({ apiKey: 'k-123', fetch });
    const results = await provider.search('hello world', { topK: 3 });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://api.tavily.com/search');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['authorization'], 'Bearer k-123');
    const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
    assert.equal(body['query'], 'hello world');
    assert.equal(body['max_results'], 3);
    assert.equal(body['include_raw_content'], false);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.title, 'Test result');
    assert.equal(results[0]!.url, 'https://example.com/x');
    assert.equal(results[0]!.snippet, 'snippet text');
    assert.equal(results[0]!.source, 'example.com');
    assert.equal(results[0]!.score, 0.9);
    assert.equal(results[0]!.publishedAt, '2026-05-01');
  });

  it('translates freshness=week to days=7 + topic=news', async () => {
    const { fetch, calls } = makeMockFetch(() => ({
      status: 200,
      body: { results: [] },
    }));
    const provider = createTavilyProvider({ apiKey: 'k', fetch });
    await provider.search('q', { freshness: 'week' });
    const body = JSON.parse(calls[0]!.body ?? '{}') as Record<string, unknown>;
    assert.equal(body['days'], 7);
    assert.equal(body['topic'], 'news');
  });

  it('prefixes site filter into the query string', async () => {
    const { fetch, calls } = makeMockFetch(() => ({
      status: 200,
      body: { results: [] },
    }));
    const provider = createTavilyProvider({ apiKey: 'k', fetch });
    await provider.search('odoo invoice', { site: 'omadia.ai' });
    const body = JSON.parse(calls[0]!.body ?? '{}') as Record<string, unknown>;
    assert.equal(body['query'], 'site:omadia.ai odoo invoice');
  });

  it('clamps topK to [1, 20]', async () => {
    const { fetch, calls } = makeMockFetch(() => ({
      status: 200,
      body: { results: [] },
    }));
    const provider = createTavilyProvider({ apiKey: 'k', fetch });
    await provider.search('q', { topK: 500 });
    await provider.search('q', { topK: 0 });
    const body1 = JSON.parse(calls[0]!.body ?? '{}') as Record<string, unknown>;
    const body2 = JSON.parse(calls[1]!.body ?? '{}') as Record<string, unknown>;
    assert.equal(body1['max_results'], 20);
    assert.equal(body2['max_results'], 1);
  });

  it('throws WebSearchAuthError on 401', async () => {
    const { fetch } = makeMockFetch(() => ({
      status: 401,
      body: { error: 'invalid key' },
    }));
    const provider = createTavilyProvider({ apiKey: 'bad', fetch });
    await assert.rejects(
      () => provider.search('q', {}),
      (err: unknown) => err instanceof WebSearchAuthError,
    );
  });

  it('throws WebSearchQuotaError on 429', async () => {
    const { fetch } = makeMockFetch(() => ({
      status: 429,
      body: { error: 'quota exceeded' },
    }));
    const provider = createTavilyProvider({ apiKey: 'k', fetch });
    await assert.rejects(
      () => provider.search('q', {}),
      (err: unknown) => err instanceof WebSearchQuotaError,
    );
  });

  it('throws WebSearchProviderError on other 5xx', async () => {
    const { fetch } = makeMockFetch(() => ({
      status: 500,
      body: { error: 'internal' },
    }));
    const provider = createTavilyProvider({ apiKey: 'k', fetch });
    await assert.rejects(
      () => provider.search('q', {}),
      (err: unknown) => err instanceof WebSearchProviderError,
    );
  });
});

describe('createBraveProvider', () => {
  it('GETs with X-Subscription-Token and parses web.results', async () => {
    const { fetch, calls } = makeMockFetch(() => ({
      status: 200,
      body: {
        web: {
          results: [
            {
              title: 'Brave hit <strong>highlight</strong>',
              url: 'https://news.example.com/article',
              description: 'desc with <strong>match</strong>',
              page_age: '2026-04-30T12:00:00Z',
              meta_url: { hostname: 'news.example.com' },
            },
          ],
        },
      },
    }));
    const provider = createBraveProvider({ apiKey: 'tok-xyz', fetch });
    const results = await provider.search('query', { topK: 5 });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.match(call.url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
    assert.match(call.url, /q=query/);
    assert.match(call.url, /count=5/);
    assert.equal(call.method, 'GET');
    assert.equal(call.headers['x-subscription-token'], 'tok-xyz');

    assert.equal(results.length, 1);
    assert.equal(results[0]!.title, 'Brave hit highlight'); // HTML stripped
    assert.equal(results[0]!.snippet, 'desc with match');
    assert.equal(results[0]!.source, 'news.example.com');
    assert.equal(results[0]!.publishedAt, '2026-04-30T12:00:00Z');
  });

  it('translates freshness=day to pd', async () => {
    const { fetch, calls } = makeMockFetch(() => ({
      status: 200,
      body: { web: { results: [] } },
    }));
    const provider = createBraveProvider({ apiKey: 'k', fetch });
    await provider.search('q', { freshness: 'day' });
    assert.match(calls[0]!.url, /freshness=pd/);
  });

  it('throws WebSearchAuthError on 403', async () => {
    const { fetch } = makeMockFetch(() => ({
      status: 403,
      body: { message: 'forbidden' },
    }));
    const provider = createBraveProvider({ apiKey: 'bad', fetch });
    await assert.rejects(
      () => provider.search('q', {}),
      (err: unknown) => err instanceof WebSearchAuthError,
    );
  });
});

describe('createProvider (registry)', () => {
  it('builds a tavily provider when id matches', () => {
    const fetch: FetchFn = async () =>
      new Response('{}', { status: 200 });
    const p = createProvider({ providerId: 'tavily', apiKey: 'k', fetch });
    assert.equal(p.id, 'tavily');
  });

  it('throws WebSearchConfigError on empty key', () => {
    const fetch: FetchFn = async () =>
      new Response('{}', { status: 200 });
    assert.throws(() =>
      createProvider({ providerId: 'tavily', apiKey: '', fetch }),
    );
  });
});

describe('createWebSearchService', () => {
  function makeFakeProvider(returns: Array<{ delay?: number; results: unknown[] }>) {
    let i = 0;
    const provider = {
      id: 'tavily' as const,
      // eslint-disable-next-line @typescript-eslint/require-await
      async search(): Promise<never> {
        const next = returns[i++];
        if (!next) throw new Error('no more canned responses');
        if (next.delay) await new Promise((r) => setTimeout(r, next.delay));
        return next.results as never;
      },
    };
    return provider;
  }

  it('returns empty results without provider call for empty query', async () => {
    const provider = makeFakeProvider([]);
    const cache = new TtlLruCache<SearchResponse>(10, 1000);
    const svc = createWebSearchService({
      provider,
      cache,
      defaultTopK: 5,
      searchTtlMs: 1000,
    });
    const r = await svc.search('   ');
    assert.equal(r.results.length, 0);
    assert.equal(r.cached, false);
    assert.equal(r.provider, 'tavily');
  });

  it('caches identical queries', async () => {
    const provider = makeFakeProvider([{ results: [{ a: 1 }] }]);
    const cache = new TtlLruCache<SearchResponse>(10, 60_000);
    const svc = createWebSearchService({
      provider,
      cache,
      defaultTopK: 5,
      searchTtlMs: 60_000,
    });
    const first = await svc.search('hello');
    const second = await svc.search('hello');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
  });

  it('treats different topK as different cache keys', async () => {
    const provider = makeFakeProvider([
      { results: [{ a: 1 }] },
      { results: [{ a: 1 }, { a: 2 }] },
    ]);
    const cache = new TtlLruCache<SearchResponse>(10, 60_000);
    const svc = createWebSearchService({
      provider,
      cache,
      defaultTopK: 5,
      searchTtlMs: 60_000,
    });
    const a = await svc.search('q', { topK: 3 });
    const b = await svc.search('q', { topK: 7 });
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
  });

  it('case-folds query for cache hit', async () => {
    const provider = makeFakeProvider([{ results: [] }]);
    const cache = new TtlLruCache<SearchResponse>(10, 60_000);
    const svc = createWebSearchService({
      provider,
      cache,
      defaultTopK: 5,
      searchTtlMs: 60_000,
    });
    await svc.search('Hello');
    const second = await svc.search('hello');
    assert.equal(second.cached, true);
  });
});

describe('web_search tool spec + handler', () => {
  it('exposes the expected tool name + required field', () => {
    assert.equal(searchToolSpec.name, WEB_SEARCH_TOOL_NAME);
    assert.deepEqual([...(searchToolSpec.input_schema.required ?? [])], [
      'query',
    ]);
  });

  it('rejects invalid input with a string error result', async () => {
    const provider = {
      id: 'tavily' as const,
      // eslint-disable-next-line @typescript-eslint/require-await
      async search(): Promise<never[]> {
        throw new Error('should not be called');
      },
    };
    const cache = new TtlLruCache<SearchResponse>(10, 1000);
    const svc = createWebSearchService({
      provider,
      cache,
      defaultTopK: 5,
      searchTtlMs: 1000,
    });
    const handler = createWebSearchToolHandler(svc);
    const r = await handler({ query: '' });
    assert.match(r, /^Error:/);
  });

  it('returns JSON with cite-shaped results on success', async () => {
    const provider = {
      id: 'tavily' as const,
      // eslint-disable-next-line @typescript-eslint/require-await
      async search() {
        return [
          {
            title: 'T',
            url: 'https://a.example.com/x',
            snippet: 's',
            source: 'a.example.com',
            score: 0.5,
          },
        ];
      },
    };
    const cache = new TtlLruCache<SearchResponse>(10, 1000);
    const svc = createWebSearchService({
      provider,
      cache,
      defaultTopK: 5,
      searchTtlMs: 1000,
    });
    const handler = createWebSearchToolHandler(svc);
    const r = await handler({ query: 'foo' });
    const parsed = JSON.parse(r) as Record<string, unknown>;
    assert.equal(parsed['provider'], 'tavily');
    assert.equal(parsed['query'], 'foo');
    assert.equal(parsed['cached'], false);
    assert.ok(Array.isArray(parsed['results']));
    const results = parsed['results'] as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    assert.equal(results[0]!['url'], 'https://a.example.com/x');
    assert.equal(results[0]!['source'], 'a.example.com');
    assert.equal(results[0]!['score'], 0.5);
  });

  it('returns Error: string on auth failure', async () => {
    const provider = {
      id: 'tavily' as const,
      // eslint-disable-next-line @typescript-eslint/require-await
      async search(): Promise<never> {
        throw new WebSearchAuthError('tavily');
      },
    };
    const cache = new TtlLruCache<SearchResponse>(10, 1000);
    const svc = createWebSearchService({
      provider,
      cache,
      defaultTopK: 5,
      searchTtlMs: 1000,
    });
    const handler = createWebSearchToolHandler(svc);
    const r = await handler({ query: 'foo' });
    assert.match(r, /^Error: web_search authentication failed/);
  });
});
