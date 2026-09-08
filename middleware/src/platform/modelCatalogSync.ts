/**
 * Live model-catalog sync: ask each connected provider which models it
 * serves RIGHT NOW (its own list-models API), classify them with the
 * provider's discovery rules, and re-register the result into the
 * `LlmProviderCatalog` (→ model-registry overlay → admin Providers page,
 * class/alias/role resolution, builder picker).
 *
 * The static `models` a provider declares (bundled built-in or plugin
 * manifest) is only the offline seed: it is what a fresh install sees before
 * a key exists, and what stays in place whenever the vendor API cannot be
 * reached. A discovery run that yields nothing usable never replaces a
 * working set (`empty` / `failed` keep the previous models).
 *
 * Triggers: boot (fire-and-forget, after credentials are readable), a
 * successful key verification on the providers page, an explicit
 * `POST /api/v1/admin/providers/:id/refresh-models`, and a periodic timer.
 */
import {
  applyDiscoveryRules,
  defaultLlmAdapters,
  getProviderOAuthBearer,
  readProviderApiKey,
  readProviderOAuthTokens,
  type DiscoveryDrop,
  type LlmAdapterRegistry,
  type LlmProviderCatalog,
  type LlmProviderDescriptor,
  type ProviderOAuthDeps,
} from '@omadia/llm-provider';

export type ModelCatalogSyncStatus =
  | 'discovered'
  | 'unknown-provider'
  | 'no-discovery-rules'
  | 'no-adapter'
  | 'no-credentials'
  | 'empty'
  | 'failed';

export interface ModelCatalogSyncResult {
  readonly providerId: string;
  readonly status: ModelCatalogSyncStatus;
  /** Models now registered for the provider (after this run). */
  readonly models: number;
  /** Ids the vendor listed that the rules dropped, with the reason. */
  readonly dropped: ReadonlyArray<DiscoveryDrop>;
  /** ISO timestamp of this run. */
  readonly at: string;
  readonly error?: string;
}

export interface ModelCatalogSyncDeps {
  readonly catalog: LlmProviderCatalog;
  /** Wire-format adapters; defaults to the process-wide registry. */
  readonly adapters?: LlmAdapterRegistry;
  /** Scope-bound vault read for provider credentials (the orchestrator scope). */
  readonly getSecret: (key: string) => Promise<string | undefined>;
  readonly oauth?: ProviderOAuthDeps;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly now?: () => Date;
}

export interface ModelCatalogSync {
  /** Refresh one provider. Never throws; the result carries the outcome. */
  refresh(providerId: string): Promise<ModelCatalogSyncResult>;
  /** Refresh every provider that declares discovery rules (in parallel). */
  refreshAll(): Promise<ReadonlyArray<ModelCatalogSyncResult>>;
  /** Outcome of the most recent run for a provider, if any. */
  lastResult(providerId: string): ModelCatalogSyncResult | undefined;
  /** Periodic `refreshAll` (timer is unref'd). `intervalMs <= 0` = off. */
  start(intervalMs: number): void;
  stop(): void;
}

const NO_KEY_PLACEHOLDER = 'no-key-required';

function summariseDrops(dropped: ReadonlyArray<DiscoveryDrop>): string {
  if (dropped.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${reason} ${String(n)}`).join(', ');
}

function describeDefaults(desc: LlmProviderDescriptor): string {
  const parts: string[] = [];
  for (const cls of ['frontier', 'balanced', 'fast'] as const) {
    const ofClass = desc.models.filter((m) => m.class === cls);
    const pick = ofClass.find((m) => m.classDefault === true) ?? ofClass[0];
    if (pick !== undefined) parts.push(`${cls}=${pick.modelId}`);
  }
  return parts.join(' ');
}

export function createModelCatalogSync(deps: ModelCatalogSyncDeps): ModelCatalogSync {
  const adapters = deps.adapters ?? defaultLlmAdapters;
  const log = deps.log ?? ((m: string) => console.log(`[model-discovery] ${m}`));
  const warn = deps.warn ?? ((m: string) => console.warn(`[model-discovery] ${m}`));
  const now = deps.now ?? (() => new Date());
  const results = new Map<string, ModelCatalogSyncResult>();
  const inFlight = new Map<string, Promise<ModelCatalogSyncResult>>();
  let timer: NodeJS.Timeout | undefined;

  const finish = (result: ModelCatalogSyncResult): ModelCatalogSyncResult => {
    results.set(result.providerId, result);
    return result;
  };

  const runRefresh = async (providerId: string): Promise<ModelCatalogSyncResult> => {
    const at = now().toISOString();
    const desc = deps.catalog.get(providerId);
    const currentCount = desc?.models.length ?? 0;
    const base = { providerId, at, dropped: [] as DiscoveryDrop[] };
    if (desc === undefined) {
      return finish({ ...base, status: 'unknown-provider', models: 0 });
    }
    if (desc.discovery === undefined) {
      return finish({ ...base, status: 'no-discovery-rules', models: currentCount });
    }
    const adapter = adapters.get(desc.wireFormat);
    if (adapter?.listModels === undefined) {
      return finish({ ...base, status: 'no-adapter', models: currentCount });
    }

    // Same connectivity rules as `resolveLlmProvider`: a key, an OAuth login,
    // or a keyless (local) provider — otherwise there is nothing to ask.
    const apiKey = await readProviderApiKey(deps.getSecret, providerId);
    const oauthConnected =
      desc.oauth !== undefined &&
      (await readProviderOAuthTokens(deps.getSecret, providerId)) !== undefined;
    const keyless = desc.policy?.requiresApiKey === false;
    if (apiKey === undefined && !keyless && !oauthConnected) {
      return finish({ ...base, status: 'no-credentials', models: currentCount });
    }

    let listed;
    try {
      listed = await adapter.listModels({
        apiKey: apiKey ?? NO_KEY_PLACEHOLDER,
        baseURL: desc.baseURL,
        id: providerId,
        ...(desc.quirks !== undefined ? { quirks: desc.quirks } : {}),
        ...(oauthConnected
          ? { bearerProvider: () => getProviderOAuthBearer(providerId, deps.oauth) }
          : {}),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      warn(`${providerId}: list-models call failed — keeping the current ${String(currentCount)} model(s): ${error}`);
      return finish({ ...base, status: 'failed', models: currentCount, error });
    }

    const outcome = applyDiscoveryRules(desc, listed, { now: now() });
    if (outcome.models.length === 0) {
      warn(
        `${providerId}: vendor listed ${String(listed.length)} model(s) but the discovery rules kept none (dropped: ${summariseDrops(outcome.dropped)}) — keeping the current ${String(currentCount)} model(s)`,
      );
      return finish({ ...base, status: 'empty', models: currentCount, dropped: outcome.dropped });
    }

    const next: LlmProviderDescriptor = {
      ...desc,
      models: outcome.models,
      modelsSource: 'discovered',
      modelsDiscoveredAt: at,
    };
    try {
      // Transactional: a rejected set (alias collision, invariant breach)
      // restores the previous models inside `register`.
      deps.catalog.register(next);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      warn(`${providerId}: discovered set rejected by the registry — keeping the current ${String(currentCount)} model(s): ${error}`);
      return finish({ ...base, status: 'failed', models: currentCount, dropped: outcome.dropped, error });
    }
    log(
      `${providerId}: ${String(outcome.models.length)} model(s) from ${String(listed.length)} listed (dropped: ${summariseDrops(outcome.dropped)}); defaults ${describeDefaults(next)}`,
    );
    return finish({ ...base, status: 'discovered', models: outcome.models.length, dropped: outcome.dropped });
  };

  const refresh = (providerId: string): Promise<ModelCatalogSyncResult> => {
    const running = inFlight.get(providerId);
    if (running !== undefined) return running;
    const p = runRefresh(providerId)
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        warn(`${providerId}: refresh crashed — ${error}`);
        return finish({
          providerId,
          status: 'failed',
          models: deps.catalog.get(providerId)?.models.length ?? 0,
          dropped: [],
          at: now().toISOString(),
          error,
        });
      })
      .finally(() => inFlight.delete(providerId));
    inFlight.set(providerId, p);
    return p;
  };

  const refreshAll = async (): Promise<ReadonlyArray<ModelCatalogSyncResult>> => {
    const ids = deps.catalog
      .list()
      .filter((d) => d.discovery !== undefined)
      .map((d) => d.id);
    return Promise.all(ids.map((id) => refresh(id)));
  };

  return {
    refresh,
    refreshAll,
    lastResult: (providerId) => results.get(providerId),
    start(intervalMs: number): void {
      this.stop();
      if (intervalMs <= 0) return;
      timer = setInterval(() => {
        void refreshAll();
      }, intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
