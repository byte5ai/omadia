/**
 * Public surface of `@omadia/plugin-web-search`.
 *
 * Plugin entry-point lives in `./plugin.js` (`activate`) — that one is loaded
 * by the kernel via `manifest.lifecycle.entry`. Everything re-exported here
 * is for programmatic consumers that want to depend on the plugin's types
 * (e.g. agents that call `ctx.services.get<WebSearchService>('webSearch')`
 * and want strong types for the response shape).
 */

export {
  WEB_SEARCH_SERVICE_NAME,
  WEB_SEARCH_CAPABILITY,
  activate,
  type WebSearchPluginHandle,
} from './plugin.js';

export {
  WebSearchAuthError,
  WebSearchConfigError,
  WebSearchError,
  WebSearchProviderError,
  WebSearchQuotaError,
} from './errors.js';

export type {
  ProviderId,
  SearchOptions,
  SearchProvider,
  SearchResponse,
  SearchResult,
  WebSearchService,
} from './types.js';

export { searchToolSpec, WEB_SEARCH_TOOL_NAME } from './searchTool.js';
