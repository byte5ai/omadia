import type { PluginContext } from '@omadia/plugin-api';

import { TtlLruCache } from './cache.js';
import { WebSearchConfigError } from './errors.js';
import { createProvider, isProviderId } from './providers/registry.js';
import { createWebSearchService } from './searchService.js';
import {
  WEB_SEARCH_PROMPT_DOC,
  createWebSearchToolHandler,
  searchToolSpec,
} from './searchTool.js';
import type { ProviderId, SearchResponse } from './types.js';

/**
 * @omadia/plugin-web-search — plugin entry point.
 *
 * Activation wiring:
 *   1. Read provider id + cache TTL + default topK from `ctx.config`.
 *   2. Read the active provider's API key from `ctx.secrets` (FileVault).
 *   3. Build the {@link SearchProvider} via the registry factory.
 *   4. Wrap it in a {@link WebSearchService} (cache + normalisation).
 *   5. Publish the service as `webSearch@1` for other plugins to consume.
 *   6. Register `web_search` as a native tool on the orchestrator.
 *
 * Required permissions in manifest:
 *   - `permissions.network.outbound`: the host(s) of the active provider.
 *     The kernel's HttpAccessor enforces an allow-list — empty = no calls.
 *
 * The plugin does NOT activate when the API key is missing — instead it logs
 * and returns a no-op handle. This keeps host boot resilient when the
 * operator installs the plugin but hasn't yet set the secret. Reactivation
 * after the secret lands is a regular re-install via the admin UI.
 */

export const WEB_SEARCH_SERVICE_NAME = 'webSearch';
export const WEB_SEARCH_CAPABILITY = 'webSearch@1';

const DEFAULT_PROVIDER: ProviderId = 'tavily';
const DEFAULT_TOP_K = 5;
const DEFAULT_CACHE_TTL_SEC = 600; // 10 min — search-result freshness vs. quota.
const DEFAULT_CACHE_MAX_ENTRIES = 200;

export interface WebSearchPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<WebSearchPluginHandle> {
  ctx.log('[web-search] activating');

  const providerRaw = (ctx.config.get<string>('provider') ?? DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();
  const providerId: ProviderId = isProviderId(providerRaw)
    ? providerRaw
    : DEFAULT_PROVIDER;
  if (!isProviderId(providerRaw)) {
    ctx.log(
      `[web-search] config.provider='${providerRaw}' is not a known id — falling back to '${DEFAULT_PROVIDER}'`,
    );
  }

  const defaultTopK = parsePositiveInt(
    ctx.config.get<unknown>('default_top_k'),
    DEFAULT_TOP_K,
  );
  const cacheTtlSec = parsePositiveInt(
    ctx.config.get<unknown>('cache_ttl_search_sec'),
    DEFAULT_CACHE_TTL_SEC,
  );
  const cacheMaxEntries = parsePositiveInt(
    ctx.config.get<unknown>('cache_max_entries'),
    DEFAULT_CACHE_MAX_ENTRIES,
  );

  if (!ctx.http) {
    ctx.log(
      '[web-search] manifest.permissions.network.outbound is empty — plugin active but cannot reach providers; capability not published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[web-search] deactivating (no http accessor was available)');
      },
    };
  }
  const httpFetch = ctx.http.fetch.bind(ctx.http);

  const apiKeyName =
    providerId === 'tavily' ? 'tavily_api_key' : 'brave_api_key';
  const apiKey = (await ctx.secrets.get(apiKeyName))?.trim() ?? '';
  if (apiKey.length === 0) {
    ctx.log(
      `[web-search] secret '${apiKeyName}' is empty — plugin active but capability not published; consumers will see ctx.services.get('${WEB_SEARCH_SERVICE_NAME}') === undefined`,
    );
    return {
      async close(): Promise<void> {
        ctx.log('[web-search] deactivating (no api key was configured)');
      },
    };
  }

  let provider;
  try {
    provider = createProvider({
      providerId,
      fetch: httpFetch,
      apiKey,
    });
  } catch (err) {
    if (err instanceof WebSearchConfigError) {
      ctx.log(`[web-search] activation failed: ${err.message}`);
      return {
        async close(): Promise<void> {
          ctx.log('[web-search] deactivating (config error during activation)');
        },
      };
    }
    throw err;
  }

  const cache = new TtlLruCache<SearchResponse>(
    cacheMaxEntries,
    cacheTtlSec * 1000,
  );

  const service = createWebSearchService({
    provider,
    cache,
    defaultTopK,
    searchTtlMs: cacheTtlSec * 1000,
    log: (msg) => ctx.log(msg),
  });

  const disposeService = ctx.services.provide(
    WEB_SEARCH_SERVICE_NAME,
    service,
  );

  const disposeTool = ctx.tools.register(
    searchToolSpec,
    createWebSearchToolHandler(service),
    {
      promptDoc: WEB_SEARCH_PROMPT_DOC,
    },
  );

  ctx.log(
    `[web-search] ready (provider=${providerId}, defaultTopK=${String(defaultTopK)}, cacheTtl=${String(cacheTtlSec)}s, cacheMax=${String(cacheMaxEntries)})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[web-search] deactivating');
      disposeTool();
      disposeService();
      cache.clear();
    },
  };
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}
