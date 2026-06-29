/**
 * Concrete wire-format adapter registry (runtime).
 *
 * The contract (`LlmAdapter`, `LlmAdapterRegistry`) lives in
 * `@omadia/llm-provider-api`; this is the runtime that holds the registered
 * adapters and the resolution seam (`providerFactory`) reads from. The concrete
 * adapters themselves live in `@omadia/llm-adapter-*` packages so this core
 * package never imports a vendor SDK.
 *
 * A process-wide default instance (`defaultLlmAdapters`) is exported so the app
 * can register its bundled adapters once at boot (`registerAnthropicAdapter`,
 * `registerOpenAiAdapter`) and every `resolveLlmProvider` call sees them without
 * threading the registry through each consumer. Tests can build an isolated
 * `LlmAdapterRegistryImpl` and pass it explicitly to `resolveLlmProvider`.
 */
import type {
  LlmAdapter,
  LlmAdapterRegistry,
  WireFormat,
} from '@omadia/llm-provider-api';

export class LlmAdapterRegistryImpl implements LlmAdapterRegistry {
  private readonly adapters = new Map<WireFormat, LlmAdapter>();

  register(adapter: LlmAdapter): void {
    this.adapters.set(adapter.wireFormat, adapter);
  }

  get(wireFormat: WireFormat): LlmAdapter | undefined {
    return this.adapters.get(wireFormat);
  }

  has(wireFormat: WireFormat): boolean {
    return this.adapters.has(wireFormat);
  }

  list(): ReadonlyArray<LlmAdapter> {
    return [...this.adapters.values()];
  }

  /** Test/teardown helper — drop all registered adapters. */
  clear(): void {
    this.adapters.clear();
  }
}

/** Process-wide default registry. The app registers its bundled adapters into
 *  this at boot; `resolveLlmProvider` defaults to it. */
export const defaultLlmAdapters = new LlmAdapterRegistryImpl();
