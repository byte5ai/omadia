/**
 * #1033 W1 — a keyed, lazily built pool of LLM providers.
 *
 * Until now the process held ONE provider: `llm_provider` was read once at
 * orchestrator activation and every turn ran through it, which is why a
 * per-agent model on another provider was rejected at write time ("cross-
 * provider model selection is not supported"). A model policy with a primary
 * on one provider and a fallback on another needs both to be resolvable at
 * turn time, without a restart and without building a client per turn.
 *
 * The pool wraps `resolveLlmProvider` with a per-provider-id cache:
 *
 *   - `get(id)` resolves on first use and memoises the result — including a
 *     negative result (no key), so a turn on a policy whose fallback provider
 *     is unconfigured does not re-read the vault every time. `invalidate(id)`
 *     / `invalidateAll()` drop entries when an operator adds or rotates a key,
 *     so the next `get` re-resolves.
 *   - Concurrent first calls share one in-flight resolution (the promise is
 *     cached, not the value), so a burst of turns cannot build N clients.
 *   - `usable(id)` answers the operator-facing question "could this provider
 *     serve a turn right now?" without handing out the provider.
 *
 * The pool is deliberately a thin coordination layer: credential reading, wire
 * format selection and OAuth stay in the factory. What is new is that there
 * can be more than one, addressed by id.
 */

import type { LlmProvider } from '@omadia/llm-provider-api';

import { resolveLlmProvider, type ResolveLlmProviderOptions } from './providerFactory.js';

/** Everything `resolveLlmProvider` needs except the provider id. */
export type LlmProviderPoolOptions = Omit<ResolveLlmProviderOptions, 'providerId'>;

export interface LlmProviderPool {
  /** The provider for `providerId`, or `undefined` when it cannot be built
   *  (no key, unknown wire format). Memoised per id until invalidated. */
  get(providerId: string): Promise<LlmProvider | undefined>;
  /** `true` iff `get(providerId)` would return a provider. */
  usable(providerId: string): Promise<boolean>;
  /** Drop one cached entry — the next `get` re-reads credentials. */
  invalidate(providerId: string): void;
  /** Drop every cached entry. */
  invalidateAll(): void;
  /** Ids currently held (resolved or negatively cached). Diagnostics only. */
  cachedIds(): readonly string[];
}

export function createLlmProviderPool(
  base: LlmProviderPoolOptions,
  resolve: (opts: ResolveLlmProviderOptions) => Promise<LlmProvider | undefined> = resolveLlmProvider,
): LlmProviderPool {
  const entries = new Map<string, Promise<LlmProvider | undefined>>();

  const get = (providerId: string): Promise<LlmProvider | undefined> => {
    const id = providerId.trim();
    const hit = entries.get(id);
    if (hit) return hit;
    const pending = resolve({ ...base, providerId: id }).catch((err: unknown) => {
      // A throwing factory must not poison the cache: drop the entry so the
      // next call retries, and surface the failure to this caller.
      entries.delete(id);
      throw err;
    });
    entries.set(id, pending);
    return pending;
  };

  return {
    get,
    async usable(providerId) {
      return (await get(providerId)) !== undefined;
    },
    invalidate(providerId) {
      entries.delete(providerId.trim());
    },
    invalidateAll() {
      entries.clear();
    },
    cachedIds() {
      return [...entries.keys()];
    },
  };
}
