/**
 * Provider-agnostic types for the web-search plugin.
 *
 * Search-providers (Tavily, Brave, …) implement {@link SearchProvider}; the
 * plugin's tool layer and the published `webSearch@1` service consume only
 * this surface, never provider SDKs directly. Adding a new provider = adding
 * one file under `src/providers/` and registering it in `providers/registry.ts`.
 */

export type ProviderId = 'tavily' | 'brave';

export interface SearchOptions {
  /** Number of results requested. Provider clamps to its own max if higher. */
  topK?: number;
  /** Recency filter — providers translate to their own freshness param.
   *  `undefined` = no constraint. */
  freshness?: 'day' | 'week' | 'month' | 'year';
  /** ISO 639-1 language hint, e.g. `'de'`, `'en'`. Provider passes through
   *  when supported; ignored when not. */
  language?: string;
  /** Restrict to a single domain — passed via the provider's site-filter or
   *  appended as `site:` to the query when not natively supported. */
  site?: string;
  /** Ask the provider to include extracted page content per result.
   *  Tavily honours this via `include_raw_content`; Brave returns the
   *  snippet only and ignores the flag. Defaults to `false`. */
  includeContent?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  /** Short description / excerpt. Always present, may be empty for thin
   *  result-types like image hits. */
  snippet: string;
  /** Hostname extracted from `url` for citation rendering — providers may
   *  also override with their own canonical source label. */
  source: string;
  /** ISO-8601 publication date when the provider returns one. Best-effort —
   *  many results have no published date, especially for evergreen pages. */
  publishedAt?: string;
  /** Provider-specific relevance score, normalised to 0..1 when possible.
   *  `undefined` means the provider didn't return a comparable score. */
  score?: number;
  /** Extracted page content. Only populated when {@link SearchOptions.includeContent}
   *  is `true` AND the provider supports in-band extraction. */
  content?: string;
}

export interface SearchResponse {
  /** The query that produced these results — echoed for provenance. */
  query: string;
  /** Provider that served the request. */
  provider: ProviderId;
  results: SearchResult[];
  /** Wall-clock duration of the upstream call in ms. Useful for dashboards
   *  and for the cache's logging — never used in business logic. */
  upstreamMs: number;
  /** True when the response came from the in-memory cache. */
  cached: boolean;
}

/**
 * Shape of the host-published `webSearch@1` service. Other plugins / agents
 * can reach this via `ctx.services.get<WebSearchService>('webSearch')`.
 */
export interface WebSearchService {
  search(query: string, opts?: SearchOptions): Promise<SearchResponse>;
  /** The active provider id — useful for diagnostic logs. */
  readonly providerId: ProviderId;
}

/**
 * Per-provider implementation contract. Pure: no caching, no rate-limit, no
 * normalisation of options — those happen one layer up so a provider stays
 * a thin SDK wrapper.
 */
export interface SearchProvider {
  readonly id: ProviderId;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
