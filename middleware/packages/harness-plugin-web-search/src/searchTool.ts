import type { NativeToolSpec } from '@omadia/plugin-api';
import { z } from 'zod';

import {
  WebSearchAuthError,
  WebSearchConfigError,
  WebSearchError,
  WebSearchProviderError,
  WebSearchQuotaError,
} from './errors.js';
import type { SearchOptions, WebSearchService } from './types.js';

/**
 * `web_search` native tool. Forwarded into Claude's tool-list at activation
 * time via `ctx.tools.register(searchToolSpec, handler, options)`.
 *
 * Tool result shape (success): JSON `{ provider, query, cached, results: [...] }`.
 * Tool result shape (error):   `Error: <message>` — the orchestrator-side
 * convention; the LLM sees a recoverable signal and can retry / pivot rather
 * than crashing the turn.
 */

export const WEB_SEARCH_TOOL_NAME = 'web_search';

const FreshnessSchema = z.enum(['day', 'week', 'month', 'year']);

const WebSearchInputSchema = z.object({
  query: z
    .string()
    .min(1, 'query must be non-empty')
    .max(400, 'query must be ≤ 400 chars'),
  top_k: z.number().int().min(1).max(20).optional(),
  freshness: FreshnessSchema.optional(),
  /** ISO 639-1, two-letter — keep loose so the provider rejects nonsense. */
  language: z
    .string()
    .min(2)
    .max(8)
    .regex(/^[a-zA-Z-]+$/u, 'language must be a language tag')
    .optional(),
  site: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/u, 'site must be a hostname')
    .optional(),
  include_content: z.boolean().optional(),
});

export const searchToolSpec: NativeToolSpec = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    'Live web search via the configured provider (Tavily by default, optionally Brave). Returns structured citation objects for the top results: title, URL, source hostname, snippet, and (when `include_content` is true and the provider supports it) the extracted page content. Use this when the answer requires up-to-date facts the model cannot know — recent news, current pricing, fresh release notes, today\'s weather, just-published research. Cite the URL field in your reply rather than paraphrasing without attribution. Avoid for evergreen knowledge the model already has reliably.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Free-text search query. Keep it specific — providers are full-text engines, not LLMs. ≤ 400 chars.',
      },
      top_k: {
        type: 'integer',
        description:
          'Number of results to return (1–20). Defaults to the operator-configured value (typically 5).',
      },
      freshness: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description:
          'Recency filter. `day` = past 24h, `week` = past 7d, etc. Omit when recency does not matter.',
      },
      language: {
        type: 'string',
        description:
          'ISO 639-1 language hint, e.g. `de` or `en`. Provider passes through when supported.',
      },
      site: {
        type: 'string',
        description:
          'Restrict results to a single domain, e.g. `byte5.de`. Translates to a `site:` filter when the provider lacks a native flag.',
      },
      include_content: {
        type: 'boolean',
        description:
          'Ask the provider to include extracted page content per result (Tavily only — Brave returns the snippet only and silently ignores). Default false.',
      },
    },
    required: ['query'],
  },
};

/**
 * Build the tool handler bound to a given service instance. Returned as a
 * pure async function so the plugin entry can pass it straight to
 * `ctx.tools.register(...)` without a wrapping class.
 */
export function createWebSearchToolHandler(
  service: WebSearchService,
): (input: unknown) => Promise<string> {
  return async (input: unknown): Promise<string> => {
    const parsed = WebSearchInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Error: invalid web_search input — ${detail}`;
    }
    const { query, top_k, freshness, language, site, include_content } =
      parsed.data;
    const opts: SearchOptions = {};
    if (top_k !== undefined) opts.topK = top_k;
    if (freshness !== undefined) opts.freshness = freshness;
    if (language !== undefined) opts.language = language;
    if (site !== undefined) opts.site = site;
    if (include_content !== undefined) opts.includeContent = include_content;

    try {
      const response = await service.search(query, opts);
      return JSON.stringify({
        provider: response.provider,
        query: response.query,
        cached: response.cached,
        upstream_ms: response.upstreamMs,
        results: response.results.map((r) => ({
          title: r.title,
          url: r.url,
          source: r.source,
          snippet: r.snippet,
          ...(r.publishedAt ? { published_at: r.publishedAt } : {}),
          ...(r.score !== undefined ? { score: r.score } : {}),
          ...(r.content ? { content: r.content } : {}),
        })),
      });
    } catch (err) {
      if (err instanceof WebSearchAuthError) {
        return `Error: web_search authentication failed for provider '${err.providerId}' — operator must rotate the API key`;
      }
      if (err instanceof WebSearchQuotaError) {
        return `Error: web_search quota exceeded for provider '${err.providerId}' — try again later or switch providers`;
      }
      if (err instanceof WebSearchConfigError) {
        return `Error: web_search misconfigured — ${err.message}`;
      }
      if (err instanceof WebSearchProviderError) {
        return `Error: web_search provider '${err.providerId}' failed — ${err.message}`;
      }
      if (err instanceof WebSearchError) {
        return `Error: ${err.message}`;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: web_search unexpected failure — ${msg}`;
    }
  };
}

export const WEB_SEARCH_PROMPT_DOC = `\`web_search\`: Frische Web-Suche über den konfigurierten Provider (Tavily standardmäßig, optional Brave). Liefert strukturierte Zitate mit Titel, URL, Hostname, Snippet und — bei \`include_content: true\` und Tavily — extrahiertem Volltext. Nutze das Tool, wenn die Antwort tagesaktuelle Fakten braucht (Nachrichten, Preise, kürzliche Releases, Wetter), nicht für Allgemeinwissen, das das Modell ohnehin kennt. Zitiere die URLs aus dem Result direkt; paraphrasiere nicht ohne Quellenangabe. Halte \`query\` spezifisch — Provider sind Volltext-Engines, keine LLMs.`;
