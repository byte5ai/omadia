/**
 * LLM provider catalog (provider-plugin seam).
 *
 * A kernel-owned registry of provider descriptors contributed by plugins. The
 * kernel populates it at manifest-load (before any plugin activates) from each
 * plugin's `llm_provider` manifest block, then publishes it as a service so the
 * orchestrator can resolve a plugin-contributed provider at its own activation
 * regardless of load order.
 *
 * Registering a provider also registers its models into the model-registry
 * overlay (so admin/class/role resolution sees them); unregistering cleans both
 * up. A descriptor names a `wireFormat`; the matching adapter (registered into
 * the `LlmAdapterRegistry` by a `@omadia/llm-adapter-*` package) builds the
 * concrete provider — so a declarative descriptor (no plugin code) drives an
 * existing adapter via baseURL + quirk flags.
 */
import type { LlmProviderDescriptor } from '@omadia/llm-provider-api';

import { registerExternalModels } from './modelRegistry.js';

// The descriptor contract (LlmProviderDescriptor, ProviderQuirks, ProviderPolicy,
// WireFormat) now lives in the versioned contract package. Re-export it here so
// existing `@omadia/llm-provider` consumers are unaffected; the runtime catalog
// below is unchanged.
export type {
  LlmProviderDescriptor,
  ProviderPolicy,
  ProviderQuirks,
  WireFormat,
} from '@omadia/llm-provider-api';

export class LlmProviderCatalog {
  private readonly entries = new Map<
    string,
    { desc: LlmProviderDescriptor; disposeModels: () => void }
  >();
  /** The BASE layer: bundled descriptors a plugin-contributed provider may
   *  shadow but never destroy (#1451). Written only by {@link registerBase}. */
  private readonly bundled = new Map<string, LlmProviderDescriptor>();

  /**
   * Register a BUNDLED provider: same effect as {@link register}, plus the
   * descriptor is remembered as the base layer for its id.
   *
   * A plugin may contribute a provider under a built-in id (the Hub's
   * `@omadia/plugin-llm-anthropic` ships `id: anthropic`) and legitimately
   * replaces the bundled entry while installed. Before #1451 its UNINSTALL
   * left the id with no entry at all until the next restart, which took the
   * built-in provider down with it: no Anthropic model in the registry, every
   * `class:*` ref unresolvable, and the orchestrator publishing `class:balanced`
   * as its model — an opaque vendor 404 on every turn. Remembering the bundled
   * descriptor here is what lets {@link unregister} put it back.
   */
  registerBase(desc: LlmProviderDescriptor): void {
    this.register(desc);
    this.bundled.set(desc.id, desc);
  }

  /** True when `id` names a BUNDLED provider — i.e. a plugin registering under
   *  it shadows a built-in rather than contributing a new provider (#1451). */
  isBundled(id: string): boolean {
    return this.bundled.has(id);
  }

  /** Register (or idempotently replace) a provider and its models. Throws if the
   *  models violate a registry invariant (collision with core/other ids etc.).
   *  Transactional on replace: when the NEW set is rejected, the previous set
   *  is put back so a bad discovery run can never leave a provider modelless. */
  register(desc: LlmProviderDescriptor): void {
    const existing = this.entries.get(desc.id);
    if (existing !== undefined) existing.disposeModels();
    let disposeModels: () => void;
    try {
      disposeModels = registerExternalModels(desc.models);
    } catch (err) {
      if (existing !== undefined) {
        const restored = registerExternalModels(existing.desc.models);
        this.entries.set(desc.id, { desc: existing.desc, disposeModels: restored });
      }
      throw err;
    }
    this.entries.set(desc.id, { desc, disposeModels });
  }

  get(id: string): LlmProviderDescriptor | undefined {
    return this.entries.get(id)?.desc;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): ReadonlyArray<LlmProviderDescriptor> {
    return [...this.entries.values()].map((e) => e.desc);
  }

  /** Drop a provider and its models. When the id names a BUNDLED provider the
   *  base-layer descriptor is registered again instead of leaving the id empty
   *  (#1451) — unregistering a plugin that shadowed a built-in restores the
   *  built-in. Throws only if re-registering the bundled models violates a
   *  registry invariant, which cannot happen for the models just disposed. */
  unregister(id: string): void {
    const e = this.entries.get(id);
    if (e === undefined) return;
    e.disposeModels();
    this.entries.delete(id);
    const base = this.bundled.get(id);
    if (base !== undefined) this.register(base);
  }

  clear(): void {
    for (const e of this.entries.values()) e.disposeModels();
    this.entries.clear();
    this.bundled.clear();
  }
}
