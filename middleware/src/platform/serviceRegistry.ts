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
  | 'transcription'
  | (string & {});

/** A registration remembered for its owner so `disposeBySource` can unwind
 *  it. `dispose` reports whether the call actually changed the map — a
 *  registration the plugin already released itself returns false, which is
 *  what makes `disposeBySource` idempotent. */
interface OwnedRegistration {
  readonly name: ServiceName;
  readonly dispose: () => boolean;
}

export class ServiceRegistry {
  private readonly providers = new Map<ServiceName, unknown>();

  /** Dispose handles from `provide`/`replace`, keyed by the plugin that made
   *  them. Core's own boot-time registrations pass no owner and are therefore
   *  never bulk-disposed — nothing tears the kernel down mid-process. */
  private readonly owned = new Map<string, OwnedRegistration[]>();

  /** Register a provider. Throws on duplicate — if two plugins both provide
   *  'graph', the operator needs to uninstall one.
   *
   *  `owner` is the registering plugin's agentId. `createPluginContext`
   *  supplies it from the kernel-known id, so attribution never comes from
   *  the caller. Omitted for core's own registrations. */
  provide<T>(name: ServiceName, impl: T, owner?: string): () => void {
    if (this.providers.has(name)) {
      throw new Error(
        `ServiceRegistry: duplicate provider for '${String(name)}' — uninstall the existing provider first`,
      );
    }
    this.providers.set(name, impl);
    const dispose = (): boolean => {
      if (this.providers.get(name) !== impl) return false;
      this.providers.delete(name);
      return true;
    };
    return this.track(owner, name, dispose);
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
  replace<T>(name: ServiceName, impl: T, owner?: string): () => void {
    const previous = this.providers.get(name);
    if (previous === undefined) {
      throw new Error(
        `ServiceRegistry: cannot replace '${String(name)}' — no provider registered (use provide() instead)`,
      );
    }
    this.providers.set(name, impl);
    const dispose = (): boolean => {
      // Only restore if our replacement is still the active one. If a
      // later `replace` already shadowed us, our restore is a no-op.
      if (this.providers.get(name) !== impl) return false;
      this.providers.set(name, previous);
      return true;
    };
    return this.track(owner, name, dispose);
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

  /**
   * Unregister every service the given plugin still holds. Returns the count
   * of registrations actually taken down (0 when the plugin owned none or
   * released them all itself). Idempotent: a second call is a no-op.
   *
   * Used by the kernel on plugin deactivate as a fail-safe — the same shape
   * as `PluginRouteRegistry.disposeBySource`, one layer down. A provider
   * whose `close()` body forgets to call its dispose handle would otherwise
   * leave the service registered against a torn-down module: consumers keep
   * resolving a dead implementation, and the reinstall throws
   * 'duplicate provider' because nothing ever removed the old entry.
   */
  disposeBySource(pluginId: string): number {
    const registrations = this.owned.get(pluginId);
    if (registrations === undefined) return 0;
    this.owned.delete(pluginId);
    let count = 0;
    // LIFO: a `replace` restores whatever was live when it ran, so stacked
    // registrations have to unwind newest-first or an older restore would
    // reinstate a provider a newer one has since shadowed.
    for (let i = registrations.length - 1; i >= 0; i -= 1) {
      const registration = registrations[i];
      if (registration !== undefined && registration.dispose()) count += 1;
    }
    return count;
  }

  /** Remember a dispose handle against its owner and hand the caller the
   *  same handle back. Unowned (core) registrations are returned untracked. */
  private track(
    owner: string | undefined,
    name: ServiceName,
    dispose: () => boolean,
  ): () => void {
    if (owner === undefined) return dispose;
    const registrations = this.owned.get(owner) ?? [];
    registrations.push({ name, dispose });
    this.owned.set(owner, registrations);
    return dispose;
  }
}
