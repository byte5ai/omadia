/**
 * #1080 — keep the kernel LLM provider pool in step with the vault.
 *
 * The pool memoises the resolved provider per id, including a negative "no
 * key" answer. Booting without a key therefore cached `anthropic → undefined`
 * for the process lifetime, and a removed key kept serving the client built
 * with it. This listener is subscribed to the kernel vault's write events and
 * drops exactly the entries a credential write can make stale.
 *
 * Classification of a key in the pool's credential scope:
 *   - `provider:<id>/api_key` (and the legacy flat `anthropic_api_key`): drop
 *     the entry AND clear the provider's breaker. A new key is a new
 *     credential; a cooldown earned by the old one (e.g. a 401 burst) must not
 *     keep routing turns to the fallback.
 *   - `provider:<id>/oauth_access_token`: drop the entry only. Connecting or
 *     disconnecting decides whether the provider resolves at all, but hourly
 *     rotation is the SAME credential and the bearer is resolved per request,
 *     so the breaker keeps its state.
 *   - everything else (`verified_at`, the refresh/expiry/updated OAuth leaves,
 *     unrelated secrets): ignored — notably a verify must not reset a breaker.
 *   - a scope purge: drop every entry and clear every breaker.
 */

import type { LlmProviderPool } from '@omadia/llm-provider';
import { legacyProviderApiKeyVaultKey } from '@omadia/llm-provider';

import type { SecretVaultWriteEvent } from '../secrets/vaultWriteEvents.js';
import { providerIdFromApiKeyVaultKey } from './providerCredentialVerifier.js';

/** The slice of the pool this listener touches — narrow for tests. */
export type InvalidatablePool = Pick<
  LlmProviderPool,
  'invalidate' | 'invalidateAll'
> & {
  readonly health: Pick<LlmProviderPool['health'], 'markHealthy' | 'snapshot'>;
};

export type ProviderCredentialChange =
  | { readonly providerId: string; readonly kind: 'api_key' }
  | { readonly providerId: string; readonly kind: 'oauth_access' };

const OAUTH_ACCESS_KEY = /^provider:(.+)\/oauth_access_token$/;

/** Map a vault key to the provider credential it holds, or `undefined`. */
export function classifyProviderCredentialKey(
  vaultKey: string,
): ProviderCredentialChange | undefined {
  const apiKeyProvider = providerIdFromApiKeyVaultKey(vaultKey);
  if (apiKeyProvider !== undefined) {
    return { providerId: apiKeyProvider, kind: 'api_key' };
  }
  if (vaultKey === legacyProviderApiKeyVaultKey('anthropic')) {
    return { providerId: 'anthropic', kind: 'api_key' };
  }
  const oauth = OAUTH_ACCESS_KEY.exec(vaultKey);
  if (oauth?.[1] !== undefined) {
    return { providerId: oauth[1], kind: 'oauth_access' };
  }
  return undefined;
}

export interface ProviderPoolCredentialListenerOptions {
  readonly pool: InvalidatablePool;
  /** The vault scope the pool's `getSecret` reads (the orchestrator's). */
  readonly scope: string;
  readonly log?: (message: string) => void;
}

export function createProviderPoolCredentialListener(
  opts: ProviderPoolCredentialListenerOptions,
): (event: SecretVaultWriteEvent) => void {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { pool } = opts;

  return (event) => {
    if (event.scope !== opts.scope) return;

    if ('purged' in event) {
      pool.invalidateAll();
      for (const entry of pool.health.snapshot()) {
        pool.health.markHealthy(entry.providerId);
      }
      log(
        `[provider-pool] credential scope ${event.scope} purged — every cached provider and breaker dropped`,
      );
      return;
    }

    // One invalidation per provider even when a batch wrote several of its
    // leaves; an api-key change wins over an oauth one for the breaker reset.
    const changes = new Map<string, ProviderCredentialChange['kind']>();
    for (const key of event.keys) {
      const change = classifyProviderCredentialKey(key);
      if (change === undefined) continue;
      if (changes.get(change.providerId) !== 'api_key') {
        changes.set(change.providerId, change.kind);
      }
    }

    for (const [providerId, kind] of changes) {
      pool.invalidate(providerId);
      if (kind === 'api_key') {
        pool.health.markHealthy(providerId);
        log(
          `[provider-pool] '${providerId}' API key changed — cached provider and breaker dropped`,
        );
      } else {
        log(
          `[provider-pool] '${providerId}' OAuth access token changed — cached provider dropped`,
        );
      }
    }
  };
}
