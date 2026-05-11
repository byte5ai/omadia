import {
  WebSearchAuthError,
  WebSearchProviderError,
  WebSearchQuotaError,
} from '../errors.js';
import type {
  ProviderId,
  SearchOptions,
  SearchProvider,
  SearchResult,
} from '../types.js';

/**
 * Tavily Search provider.
 *
 * Tavily is built for AI agents — its API returns clean snippets, optional
 * extracted full-text (`include_raw_content`), and per-result scores. It is
 * the default provider for this plugin.
 *
 * Endpoint: POST https://api.tavily.com/search
 * Auth:    Bearer token in `Authorization` header.
 * Docs:    https://docs.tavily.com/docs/rest-api/api-reference
 */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const PROVIDER_ID: ProviderId = 'tavily';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface TavilyProviderOptions {
  apiKey: string;
  fetch: FetchFn;
  /** Hard cancel per call. Default 15 s. Tavily's p95 is ~1.5 s but the
   *  long-tail under load can spike past 5 s, so 15 s is a forgiving cap
   *  that still prevents an indefinite hang in the orchestrator turn. */
  timeoutMs?: number;
}

interface TavilyApiResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  raw_content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface TavilyApiResponse {
  results?: unknown;
}

export function createTavilyProvider(
  opts: TavilyProviderOptions,
): SearchProvider {
  const apiKey = opts.apiKey;
  const fetchFn = opts.fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    id: PROVIDER_ID,
    async search(
      query: string,
      searchOpts: SearchOptions,
    ): Promise<SearchResult[]> {
      const body: Record<string, unknown> = {
        query: searchOpts.site
          ? `site:${searchOpts.site} ${query}`
          : query,
        max_results: clampTopK(searchOpts.topK),
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: searchOpts.includeContent === true,
      };
      const days = freshnessToDays(searchOpts.freshness);
      if (days !== undefined) {
        body['days'] = days;
        // Tavily applies `days` only when topic === 'news'; switching keeps
        // recency filtering meaningful. Without `news`, `days` is silently
        // ignored, which would surprise the operator.
        body['topic'] = 'news';
      }

      let response: Response;
      try {
        response = await fetchFn(TAVILY_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new WebSearchProviderError(PROVIDER_ID, `request failed: ${msg}`);
      }

      if (!response.ok) {
        const body = await safeReadText(response);
        if (response.status === 401 || response.status === 403) {
          throw new WebSearchAuthError(PROVIDER_ID);
        }
        if (response.status === 429) {
          throw new WebSearchQuotaError(
            PROVIDER_ID,
            `HTTP 429 — ${body.slice(0, 200)}`,
          );
        }
        throw new WebSearchProviderError(
          PROVIDER_ID,
          `HTTP ${String(response.status)}`,
          response.status,
          body,
        );
      }

      const json = (await response.json()) as TavilyApiResponse;
      const raw = Array.isArray(json.results) ? json.results : [];
      const out: SearchResult[] = [];
      for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const item = r as TavilyApiResult;
        const url = asString(item.url);
        const title = asString(item.title);
        if (!url || !title) continue;
        const snippet = asString(item.content) ?? '';
        const score = asNumber(item.score);
        const publishedAt = asString(item.published_date);
        const content =
          searchOpts.includeContent === true
            ? asString(item.raw_content)
            : undefined;
        const result: SearchResult = {
          title,
          url,
          snippet,
          source: hostnameOf(url),
        };
        if (publishedAt !== undefined) result.publishedAt = publishedAt;
        if (score !== undefined) result.score = score;
        if (content !== undefined) result.content = content;
        out.push(result);
      }
      return out;
    },
  };
}

function clampTopK(raw: number | undefined): number {
  if (raw === undefined) return 5;
  if (!Number.isFinite(raw)) return 5;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > 20) return 20;
  return n;
}

function freshnessToDays(
  freshness: SearchOptions['freshness'],
): number | undefined {
  switch (freshness) {
    case 'day':
      return 1;
    case 'week':
      return 7;
    case 'month':
      return 30;
    case 'year':
      return 365;
    default:
      return undefined;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 500);
  } catch {
    return '';
  }
}
