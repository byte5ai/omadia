import { WebSearchConfigError } from '../errors.js';
import type { ProviderId, SearchProvider } from '../types.js';
import { createBraveProvider } from './brave.js';
import { createTavilyProvider } from './tavily.js';

/**
 * Provider factory. Picks the implementation by id and constructs it with
 * the matching API key. Throws {@link WebSearchConfigError} if the operator
 * selected a provider whose key is missing — caller (plugin's activate)
 * surfaces this as a plain config error rather than a runtime crash.
 */

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreateProviderOptions {
  providerId: ProviderId;
  fetch: FetchFn;
  /** API key for the active provider. Other providers' keys are not needed. */
  apiKey: string;
}

export function createProvider(opts: CreateProviderOptions): SearchProvider {
  if (!opts.apiKey || opts.apiKey.trim().length === 0) {
    throw new WebSearchConfigError(
      `provider '${opts.providerId}' selected but no API key is configured`,
    );
  }

  switch (opts.providerId) {
    case 'tavily':
      return createTavilyProvider({ apiKey: opts.apiKey, fetch: opts.fetch });
    case 'brave':
      return createBraveProvider({ apiKey: opts.apiKey, fetch: opts.fetch });
    default: {
      const exhaustive: never = opts.providerId;
      throw new WebSearchConfigError(
        `unknown provider id '${String(exhaustive)}' — valid ids are 'tavily' | 'brave'`,
      );
    }
  }
}

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'tavily' || value === 'brave';
}
