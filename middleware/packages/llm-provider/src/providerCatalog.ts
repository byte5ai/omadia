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

  /** Register (or idempotently replace) a provider and its models. Throws if the
   *  models violate a registry invariant (collision with core/other ids etc.). */
  register(desc: LlmProviderDescriptor): void {
    const existing = this.entries.get(desc.id);
    if (existing !== undefined) existing.disposeModels();
    const disposeModels = registerExternalModels(desc.models);
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

  unregister(id: string): void {
    const e = this.entries.get(id);
    if (e === undefined) return;
    e.disposeModels();
    this.entries.delete(id);
  }

  clear(): void {
    for (const e of this.entries.values()) e.disposeModels();
    this.entries.clear();
  }
}
