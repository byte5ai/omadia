/**
 * Error hierarchy for the web-search plugin. All errors thrown out of the
 * `webSearch@1` service or the `web_search` tool extend {@link WebSearchError}
 * so callers can do a single `instanceof` check at the boundary.
 *
 * Tool-handler-level errors are always converted to `Error: <message>`
 * tool-result strings (the orchestrator-side convention), so the LLM sees
 * a recoverable signal rather than an exception. Programmatic consumers
 * via `ctx.services.get('webSearch')` see the typed errors.
 */

import type { ProviderId } from './types.js';

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchError';
  }
}

/**
 * Provider returned a non-2xx response that isn't a rate-limit or auth
 * issue (covered by their own subclasses). `status` mirrors the upstream
 * HTTP status; `body` is truncated to 500 chars to avoid blowing up logs
 * when the provider returns a verbose error page.
 */
export class WebSearchProviderError extends WebSearchError {
  constructor(
    public readonly providerId: ProviderId,
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(`[${providerId}] ${message}`);
    this.name = 'WebSearchProviderError';
  }
}

/**
 * Provider rejected the call due to quota / rate-limit. Distinct from
 * {@link WebSearchProviderError} so callers can decide to fall back to a
 * second provider rather than surface an opaque failure.
 */
export class WebSearchQuotaError extends WebSearchError {
  constructor(
    public readonly providerId: ProviderId,
    message: string,
  ) {
    super(`[${providerId}] quota/rate-limit: ${message}`);
    this.name = 'WebSearchQuotaError';
  }
}

/**
 * Provider rejected the API key. Surfaced as a separate class so the admin
 * UI can show a "rotate key" hint instead of a generic upstream error.
 */
export class WebSearchAuthError extends WebSearchError {
  constructor(public readonly providerId: ProviderId) {
    super(`[${providerId}] authentication failed — verify the API key`);
    this.name = 'WebSearchAuthError';
  }
}

/**
 * Configuration issue detected at activate-time or first request — for
 * example, the operator selected `provider: brave` but never filled
 * `brave_api_key`. Thrown synchronously from the service factory.
 */
export class WebSearchConfigError extends WebSearchError {
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = 'WebSearchConfigError';
  }
}
