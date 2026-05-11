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
 * Brave Search provider.
 *
 * Endpoint: GET https://api.search.brave.com/res/v1/web/search
 * Auth:    `X-Subscription-Token` header (per Brave dashboard).
 * Docs:    https://api-dashboard.search.brave.com/app/documentation/web-search
 *
 * Brave returns no in-band extracted page content — `searchOpts.includeContent`
 * is silently ignored. Callers that need full-text either switch to Tavily or
 * (later) use a dedicated `web_fetch` capability.
 */

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const PROVIDER_ID: ProviderId = 'brave';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface BraveProviderOptions {
  apiKey: string;
  fetch: FetchFn;
  /** Hard cancel per call. Default 10 s — Brave is consistently fast. */
  timeoutMs?: number;
}

interface BraveApiResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  age?: unknown;
  page_age?: unknown;
  meta_url?: { hostname?: unknown };
}

interface BraveApiResponse {
  web?: { results?: unknown };
}

export function createBraveProvider(
  opts: BraveProviderOptions,
): SearchProvider {
  const apiKey = opts.apiKey;
  const fetchFn = opts.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    id: PROVIDER_ID,
    async search(
      query: string,
      searchOpts: SearchOptions,
    ): Promise<SearchResult[]> {
      const params = new URLSearchParams();
      const q = searchOpts.site
        ? `site:${searchOpts.site} ${query}`
        : query;
      params.set('q', q);
      params.set('count', String(clampTopK(searchOpts.topK)));
      const freshness = freshnessToBrave(searchOpts.freshness);
      if (freshness !== undefined) params.set('freshness', freshness);
      if (searchOpts.language) {
        params.set('search_lang', searchOpts.language);
      }

      const url = `${BRAVE_ENDPOINT}?${params.toString()}`;
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-subscription-token': apiKey,
          },
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

      const json = (await response.json()) as BraveApiResponse;
      const raw = Array.isArray(json.web?.results) ? json.web?.results : [];
      const out: SearchResult[] = [];
      for (const r of raw ?? []) {
        if (!r || typeof r !== 'object') continue;
        const item = r as BraveApiResult;
        const resultUrl = asString(item.url);
        const title = asString(item.title);
        if (!resultUrl || !title) continue;
        const snippet = asString(item.description) ?? '';
        const publishedAt = asString(item.page_age) ?? asString(item.age);
        const metaHostname =
          item.meta_url && typeof item.meta_url === 'object'
            ? asString(item.meta_url.hostname)
            : undefined;
        const result: SearchResult = {
          title: stripHtmlTags(title),
          url: resultUrl,
          snippet: stripHtmlTags(snippet),
          source: metaHostname ?? hostnameOf(resultUrl),
        };
        if (publishedAt !== undefined) result.publishedAt = publishedAt;
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

function freshnessToBrave(
  freshness: SearchOptions['freshness'],
): string | undefined {
  switch (freshness) {
    case 'day':
      return 'pd';
    case 'week':
      return 'pw';
    case 'month':
      return 'pm';
    case 'year':
      return 'py';
    default:
      return undefined;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Brave occasionally returns `<strong>`-wrapped fragments in `title` /
 *  `description` to highlight matches. Strip them — the orchestrator-side
 *  formatting already covers emphasis, and raw HTML in tool results is a
 *  prompt-injection vector when the LLM later quotes the snippet verbatim. */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 500);
  } catch {
    return '';
  }
}
