import type { AuthProvider, ProviderSummary } from './providers/AuthProvider.js';

/**
 * In-memory map of currently-active auth-providers keyed by their stable
 * id. The set the login-router dispatches against — same shape as before
 * OB-50, but now mutable at runtime so the admin-UI can enable/disable
 * providers without a process restart.
 *
 * Construction is responsibility of `index.ts`: it parses `AUTH_PROVIDERS`
 * env-var (= "whitelist" of allowed providers), instantiates each one
 * into a `ProviderCatalog`, then registers the subset the operator has
 * marked active in `platform_settings.auth.active_providers` — falling
 * back to the full whitelist when no override exists. The registry has
 * no knowledge of any specific provider implementation — that keeps the
 * "Entra moves to a plugin" V1.x change a one-line registration swap.
 */

export class ProviderRegistry {
  private readonly providers = new Map<string, AuthProvider>();

  register(provider: AuthProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(
        `auth-provider id collision: ${provider.id} already registered`,
      );
    }
    this.providers.set(provider.id, provider);
  }

  /** Remove a provider from the active set. Returns true iff a row was
   *  actually present. Used by the OB-50 admin-UI toggle. */
  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  /** Replace the entire active set in one shot. Convenience for the
   *  initial boot-time hydration from the platform_settings override. */
  replaceActive(providers: AuthProvider[]): void {
    this.providers.clear();
    for (const p of providers) this.register(p);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): AuthProvider | undefined {
    return this.providers.get(id);
  }

  list(): AuthProvider[] {
    return Array.from(this.providers.values());
  }

  /** Active count — handy for "no provider configured" error paths. */
  size(): number {
    return this.providers.size;
  }

  /** Public-shape summaries for the login UI. */
  summaries(): ProviderSummary[] {
    return this.list().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      kind: p.kind,
    }));
  }
}

/**
 * Whitelisted superset of providers the operator has *allowed* via the
 * `AUTH_PROVIDERS` env-var. The admin-UI can only flip providers active
 * if they exist in the catalog — so a compromised admin can never enable
 * a provider the operator didn't intend (e.g. switch on Entra in a
 * local-only deployment). Built once at boot, immutable thereafter.
 */
export class ProviderCatalog {
  private readonly providers = new Map<string, AuthProvider>();

  add(provider: AuthProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(
        `provider-catalog id collision: ${provider.id} already added`,
      );
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): AuthProvider | undefined {
    return this.providers.get(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  ids(): string[] {
    return Array.from(this.providers.keys());
  }

  list(): AuthProvider[] {
    return Array.from(this.providers.values());
  }

  size(): number {
    return this.providers.size;
  }
}

/**
 * Filter a stored "active subset" against the catalog. Anything not in
 * the catalog is silently dropped — protects against an old override
 * referencing a provider the env-var no longer whitelists.
 */
export function resolveActiveProviderIds(
  catalog: ProviderCatalog,
  storedActive: string[] | null | undefined,
): string[] {
  if (!storedActive || storedActive.length === 0) {
    // No override → all whitelisted providers are active by default.
    return catalog.ids();
  }
  const allowed = new Set(catalog.ids());
  return storedActive.filter((id) => allowed.has(id));
}

/**
 * Parse the `AUTH_PROVIDERS` env-var into a deduplicated, lower-cased
 * array of provider ids. Empty / unset → defaults to `['local']` so the
 * OSS-Demo boots straight into a usable login page.
 */
export function parseAuthProvidersEnv(raw: string | undefined): string[] {
  const list = (raw ?? 'local')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (list.length === 0) return ['local'];
  return Array.from(new Set(list));
}
