import type {
  UiRouteDescriptor,
  UiRouteDescriptorInput,
} from '@omadia/plugin-api';

/**
 * Kernel-side catalogue of plugin-served UI surfaces.
 *
 * Plugins call `ctx.uiRoutes.register({routeId, path, title})` from
 * their activate() and the accessor delegates here. The catalogue is
 * the source of truth for downstream surfaces:
 *
 *   - channel-teams' `/p/channel-teams/hub` iterates `list()` to render
 *     clickable cards.
 *   - channel-teams' `/p/channel-teams/tab-config` queries `list()` to
 *     populate the Target-Route dropdown when the operator pins a
 *     configurable Teams Tab.
 *
 * Both call sites resolve the catalogue via `ctx.services.get<
 * UiRouteCatalog>('uiRouteCatalog')`. The kernel publishes the
 * instance during boot, before any plugin activates, so consumers
 * never see an undefined catalogue.
 *
 * Entries are keyed by (`pluginId`, `routeId`). Re-registering the
 * same key throws — plugins must dispose their previous handle
 * before a hot-swap re-activates them, mirroring the route-registry
 * contract.
 *
 * `disposeBySource` is a fail-safe the kernel calls during plugin
 * deactivate — leaked dispose handles from a misbehaving plugin
 * still cannot outlive the plugin's lifecycle.
 */
export class UiRouteCatalog {
  private readonly entries = new Map<string, UiRouteDescriptor>();

  /**
   * Register a uiRoute descriptor for the given plugin. The pluginId
   * comes from the kernel-side caller (createPluginContext fills it
   * in from the activating plugin's agentId) — plugins cannot spoof
   * another plugin's surfaces.
   */
  register(
    pluginId: string,
    input: UiRouteDescriptorInput,
  ): () => void {
    if (typeof pluginId !== 'string' || pluginId.length === 0) {
      throw new Error(
        'UiRouteCatalog.register: pluginId must be a non-empty string',
      );
    }
    if (typeof input.routeId !== 'string' || input.routeId.length === 0) {
      throw new Error(
        `UiRouteCatalog.register(${pluginId}): routeId must be a non-empty string`,
      );
    }
    if (typeof input.path !== 'string' || !input.path.startsWith('/')) {
      throw new Error(
        `UiRouteCatalog.register(${pluginId}/${input.routeId}): path must start with '/'`,
      );
    }
    if (typeof input.title !== 'string' || input.title.length === 0) {
      throw new Error(
        `UiRouteCatalog.register(${pluginId}/${input.routeId}): title must be a non-empty string`,
      );
    }
    const key = `${pluginId}::${input.routeId}`;
    if (this.entries.has(key)) {
      throw new Error(
        `UiRouteCatalog: descriptor '${key}' is already registered — dispose the previous registration before re-registering (hot-swap leak)`,
      );
    }
    const descriptor: UiRouteDescriptor = {
      pluginId,
      routeId: input.routeId,
      path: input.path,
      title: input.title,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    this.entries.set(key, descriptor);
    return () => {
      // Identity-keyed dispose: only delete if the stored entry is
      // still THIS descriptor. A later registration that replaced
      // this slot must not be dropped by a stale dispose closure
      // from the previous owner.
      if (this.entries.get(key) === descriptor) {
        this.entries.delete(key);
      }
    };
  }

  /**
   * Sorted snapshot of every active descriptor. Returns a fresh array
   * each call — safe for consumers to filter/sort further.
   * Sort: (order ?? 100) ASC, then pluginId ASC, then routeId ASC.
   */
  list(): readonly UiRouteDescriptor[] {
    return [...this.entries.values()].sort((a, b) => {
      const oa = a.order ?? 100;
      const ob = b.order ?? 100;
      if (oa !== ob) return oa - ob;
      if (a.pluginId !== b.pluginId) {
        return a.pluginId.localeCompare(b.pluginId);
      }
      return a.routeId.localeCompare(b.routeId);
    });
  }

  /**
   * Drop every entry registered by the given plugin. Used by the
   * kernel on plugin deactivate as a fail-safe — plugins whose
   * close() forgets to call its per-route dispose handle still cannot
   * leak descriptors into the catalogue. Returns the count of entries
   * dropped (0 when nothing matched).
   */
  disposeBySource(pluginId: string): number {
    let count = 0;
    for (const [key, descriptor] of this.entries) {
      if (descriptor.pluginId === pluginId) {
        this.entries.delete(key);
        count += 1;
      }
    }
    return count;
  }

  /** Diagnostic: total active descriptor count. */
  size(): number {
    return this.entries.size;
  }
}
