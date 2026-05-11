/**
 * Service registry for plugin-bereitgestellte (plugin-provided) services.
 *
 * Key distinction from the other Phase-0c registries: these services don't
 * belong to the kernel. The kernel defines the INTERFACE (GraphAccessor,
 * EventBusAccessor, EmbeddingAccessor, …), and a provider-plugin IMPLEMENTS
 * and REGISTERS it. Other plugins then consume the registered provider via
 * their PluginContext (`ctx.graph`, `ctx.bus`, `ctx.embeddings`).
 *
 * Example sequence (post Phase 4):
 *   1. `@omadia/knowledge-graph` activates.
 *   2. In its activate(), it calls `ctx.services.provide('graph', impl)`.
 *   3. Kernel caches the registration keyed to the ServiceName.
 *   4. Later, `@omadia/agent-seo-analyst` activates. The Kernel
 *      resolves its PluginContext's `ctx.graph` proxy to the registered
 *      provider (or leaves it undefined if no provider is installed).
 *
 * For Phase 0c: the registry exists, the `createPluginContext` function is
 * extended to accept it, and `ctx.graph` / `ctx.bus` / `ctx.embeddings` are
 * exposed — all resolving to `undefined` until the KG extraction (Phase 4)
 * lands. No behavior change today; today's built-ins still access graph/bus/
 * embeddings through their existing direct imports, not through ctx.
 *
 * Security note: when a Provider is registered, the kernel WILL (in Phase 4)
 * wrap the accessor with a per-consumer scope filter — e.g. an uploaded agent
 * may only read graph scopes tagged with its own agentId or `public`. The
 * scope wrapping happens in `createPluginContext`, not here. This registry is
 * a naked service-locator; enforcement lives at the consumer seam.
 */

/** The known well-known service names. An open string union so future
 *  additions (e.g. 'diagrams', 'attachments', 'memory') don't require a
 *  cross-module refactor — a provider calls `provide('diagrams', impl)` and
 *  the consumer requests `ctx.services.get<DiagramAccessor>('diagrams')`. */
export type ServiceName =
  | 'graph'
  | 'bus'
  | 'embeddings'
  | 'diagrams'
  | 'attachments'
  | 'memory'
  | (string & {});

export class ServiceRegistry {
  private readonly providers = new Map<ServiceName, unknown>();

  /** Register a provider. Throws on duplicate — if two plugins both provide
   *  'graph', the operator needs to uninstall one. */
  provide<T>(name: ServiceName, impl: T): () => void {
    if (this.providers.has(name)) {
      throw new Error(
        `ServiceRegistry: duplicate provider for '${String(name)}' — uninstall the existing provider first`,
      );
    }
    this.providers.set(name, impl);
    return () => {
      if (this.providers.get(name) === impl) {
        this.providers.delete(name);
      }
    };
  }

  /**
   * OB-71 (palaia capture-pipeline): swap an already-registered provider
   * for a wrapped variant. Used by the orchestrator-extras plugin to
   * replace `knowledgeGraph` with a `CaptureFilteringKnowledgeGraph` that
   * decorates the original. Throws if no provider exists yet (use
   * `provide` for the first registration).
   *
   * The dispose handle RESTORES the previous provider reference — i.e.
   * `replace()` is rollback-safe: when the wrapping plugin deactivates,
   * the underlying KG provider stays live for the rest of the system.
   * Stacking multiple replacements is supported (LIFO restore).
   */
  replace<T>(name: ServiceName, impl: T): () => void {
    const previous = this.providers.get(name);
    if (previous === undefined) {
      throw new Error(
        `ServiceRegistry: cannot replace '${String(name)}' — no provider registered (use provide() instead)`,
      );
    }
    this.providers.set(name, impl);
    return () => {
      // Only restore if our replacement is still the active one. If a
      // later `replace` already shadowed us, our restore is a no-op.
      if (this.providers.get(name) === impl) {
        this.providers.set(name, previous);
      }
    };
  }

  get<T>(name: ServiceName): T | undefined {
    return this.providers.get(name) as T | undefined;
  }

  has(name: ServiceName): boolean {
    return this.providers.has(name);
  }

  names(): readonly string[] {
    return Array.from(this.providers.keys()) as string[];
  }
}
