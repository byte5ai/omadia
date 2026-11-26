import type { PluginConnectionVerdict, PluginContext } from '@omadia/plugin-api';

import type { ProviderId } from './types.js';

/**
 * #1974 — the kernel-run connection probe (`verifyConnection`, #1453).
 *
 * One minimal search (one result) against the selected provider with the
 * stored key, through `ctx.http`:
 *  - 401, or a 403 whose body names authentication  ⇒ `rejected`
 *  - 2xx                                             ⇒ `connected`
 *  - no key, timeout, 429, 5xx, anything else        ⇒ `inconclusive`
 *
 * A missing key is not a verdict about a key: `activate()` reports it as
 * `needs_action`, and `inconclusive` keeps that status. Never throws.
 */

/** The kernel waits 5 s; give up before that. */
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_QUERY = 'omadia';

const INCONCLUSIVE: PluginConnectionVerdict = { status: 'inconclusive' };

interface ProbeRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function probeRequest(providerId: ProviderId, apiKey: string): ProbeRequest {
  if (providerId === 'brave') {
    const params = new URLSearchParams({ q: PROBE_QUERY, count: '1' });
    return {
      url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      init: {
        method: 'GET',
        headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      },
    };
  }
  return {
    url: 'https://api.tavily.com/search',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: PROBE_QUERY, max_results: 1, search_depth: 'basic' }),
    },
  };
}

/**
 * Same rule as `classifyHttpAuthFailure` in `@omadia/plugin-api`, kept local
 * because this plugin also runs on hosts that predate that export
 * (`toolErrorCompat.ts`).
 */
export function authRejectionCause(
  status: number,
  bodyText: string,
): 'http_401' | 'http_403_auth' | undefined {
  if (status === 401) return 'http_401';
  if (status !== 403) return undefined;
  const body = bodyText.toLowerCase();
  const saysAuth =
    body.includes('unauthenticated') ||
    body.includes('authentication') ||
    body.includes('invalid_token') ||
    body.includes('invalid api key') ||
    body.includes('invalid x-api-key');
  return saysAuth ? 'http_403_auth' : undefined;
}

export async function probeWebSearch(
  ctx: PluginContext,
  providerId: ProviderId,
  apiKeyName: string,
): Promise<PluginConnectionVerdict> {
  try {
    if (!ctx.http) return INCONCLUSIVE;
    const apiKey = (await ctx.secrets.get(apiKeyName))?.trim() ?? '';
    if (apiKey.length === 0) return INCONCLUSIVE;
    const { url, init } = probeRequest(providerId, apiKey);
    const response = await ctx.http.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) return { status: 'connected', title: 'Verbunden' };
    const body = await response.text().catch(() => '');
    const cause = authRejectionCause(response.status, body);
    return cause === undefined
      ? INCONCLUSIVE
      : {
          status: 'rejected',
          cause,
          title: 'API-Schlüssel abgelehnt',
          detail: `${providerId} hat den API-Schlüssel abgelehnt — neuen Schlüssel im Setup-Formular eintragen.`,
        };
  } catch {
    return INCONCLUSIVE;
  }
}
