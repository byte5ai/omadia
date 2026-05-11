import type { TtlLruCache } from './cache.js';
import type {
  ProviderId,
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResult,
  WebSearchService,
} from './types.js';

/**
 * Wraps a {@link SearchProvider} with caching + option-normalisation. This
 * is the object the plugin publishes as the `webSearch@1` capability and
 * the object the `web_search` tool delegates to.
 *
 * Why a separate layer? Providers stay thin SDK-wrappers — they don't know
 * about the operator-configured default `topK`, the cache, or the canonical
 * cache-key shape. Putting those concerns here means the provider files
 * stay swappable without touching cache semantics.
 */

export interface SearchServiceOptions {
  provider: SearchProvider;
  cache: TtlLruCache<SearchResponse>;
  /** Default topK when the caller doesn't pass one. */
  defaultTopK: number;
  /** Per-search cache TTL in ms. */
  searchTtlMs: number;
  /** Optional logger — plugin passes `ctx.log`. */
  log?: (msg: string) => void;
}

export function createWebSearchService(
  opts: SearchServiceOptions,
): WebSearchService {
  const { provider, cache, defaultTopK, searchTtlMs } = opts;
  const log = opts.log ?? ((): void => undefined);

  return {
    providerId: provider.id,
    async search(
      rawQuery: string,
      rawOpts?: SearchOptions,
    ): Promise<SearchResponse> {
      const query = rawQuery.trim();
      if (query.length === 0) {
        // Empty query → empty result set, no provider call. Saves quota
        // when the LLM accidentally fires `web_search` with no terms.
        return {
          query,
          provider: provider.id,
          results: [],
          upstreamMs: 0,
          cached: false,
        };
      }

      const normalised = normaliseOptions(rawOpts, defaultTopK);
      const cacheKey = makeCacheKey(provider.id, query, normalised);
      const cached = cache.get(cacheKey);
      if (cached) {
        log(
          `[web-search] cache HIT provider=${provider.id} query='${truncate(query, 80)}' results=${String(cached.results.length)}`,
        );
        return { ...cached, cached: true };
      }

      const start = Date.now();
      const results = await provider.search(query, normalised);
      const upstreamMs = Date.now() - start;
      log(
        `[web-search] provider=${provider.id} query='${truncate(query, 80)}' results=${String(results.length)} upstreamMs=${String(upstreamMs)}`,
      );

      const response: SearchResponse = {
        query,
        provider: provider.id,
        results,
        upstreamMs,
        cached: false,
      };
      cache.set(cacheKey, response, searchTtlMs);
      return response;
    },
  };
}

function normaliseOptions(
  raw: SearchOptions | undefined,
  defaultTopK: number,
): SearchOptions {
  const out: SearchOptions = {
    topK: clampTopK(raw?.topK, defaultTopK),
  };
  if (raw?.freshness) out.freshness = raw.freshness;
  if (raw?.language) out.language = raw.language.toLowerCase();
  if (raw?.site) out.site = raw.site.toLowerCase();
  if (raw?.includeContent === true) out.includeContent = true;
  return out;
}

function clampTopK(raw: number | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > 20) return 20;
  return n;
}

function makeCacheKey(
  providerId: ProviderId,
  query: string,
  opts: SearchOptions,
): string {
  // Stable key — include every option that influences the upstream call so
  // two calls with different freshness don't share a result set. JSON.stringify
  // ordering is stable here because we only emit a fixed set of keys in
  // `normaliseOptions`.
  return [
    providerId,
    query.toLowerCase(),
    String(opts.topK ?? ''),
    opts.freshness ?? '',
    opts.language ?? '',
    opts.site ?? '',
    opts.includeContent === true ? '1' : '0',
  ].join('|');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/** Re-export so consumers don't need a second import. */
export type { SearchResponse, SearchResult, WebSearchService };
