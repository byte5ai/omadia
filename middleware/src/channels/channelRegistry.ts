import { createPluginContext } from '../platform/pluginContext.js';
import type { PluginRouteRegistry } from '../platform/pluginRouteRegistry.js';
import type { NotificationRouter } from '../platform/notificationRouter.js';
import type { UiRouteCatalog } from '../platform/uiRouteCatalog.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { JobScheduler } from '../plugins/jobScheduler.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { SecretVault } from '../secrets/vault.js';
import type { NativeToolRegistry } from '@omadia/orchestrator';

import type {
  ChannelHandle,
  ChannelPlugin,
  ChannelPluginResolver,
  ChannelRegistry,
  CoreApi,
} from '@omadia/channel-sdk';
import type { ExpressRouteRegistry } from './routeRegistry.js';

/**
 * Runtime registry for installed channel packages. At middleware startup it
 * walks the installed-registry, picks every entry whose catalog-manifest
 * declares `kind: channel`, and calls `activate()` on the corresponding
 * ChannelPlugin (looked up via the resolver). Handles are retained so a
 * later deactivate / uninstall can `close()` them cleanly.
 *
 * v1 scope: fixed-imports resolver (see `FixedChannelPluginResolver` below).
 * Dynamic load/unload from tarballs arrives with Slice 2.5.
 */
export interface ChannelRegistryDeps {
  catalog: PluginCatalog;
  installedRegistry: InstalledRegistry;
  vault: SecretVault;
  serviceRegistry: ServiceRegistry;
  nativeToolRegistry: NativeToolRegistry;
  pluginRouteRegistry: PluginRouteRegistry;
  notificationRouter: NotificationRouter;
  uiRouteCatalog: UiRouteCatalog;
  jobScheduler: JobScheduler;
  resolver: ChannelPluginResolver;
  coreApi: CoreApi;
  routes: ExpressRouteRegistry;
}

export class DefaultChannelRegistry implements ChannelRegistry {
  private readonly handles = new Map<string, ChannelHandle>();

  constructor(private readonly deps: ChannelRegistryDeps) {}

  async activateAllInstalled(): Promise<void> {
    for (const entry of this.deps.installedRegistry.list()) {
      const plugin = this.deps.catalog.get(entry.id);
      if (!plugin || plugin.plugin.kind !== 'channel') continue;
      try {
        await this.activate(entry.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[channels] failed to activate ${entry.id}:`,
          message,
        );
      }
    }
  }

  async activate(agentId: string): Promise<void> {
    if (this.handles.has(agentId)) return;

    const catalogEntry = this.deps.catalog.get(agentId);
    if (!catalogEntry || catalogEntry.plugin.kind !== 'channel') {
      throw new Error(`channel not in catalog: ${agentId}`);
    }

    // Phase 5B: resolver may be sync (FixedChannelPluginResolver) or async
    // (DynamicChannelPluginResolver — dynamic-imports dist/plugin.js).
    // `await` accepts both shapes.
    const impl: ChannelPlugin | undefined = await this.deps.resolver.resolve(
      agentId,
    );
    if (!impl) {
      // Manifest lists the channel but the core has no code for it yet.
      // Expected during Slice 2.2 (scaffold without concrete channels).
      console.warn(
        `[channels] no ChannelPlugin implementation registered for ${agentId} — manifest loaded, runtime skipped (expected until Slice 2.3)`,
      );
      return;
    }

    const ctx = createPluginContext({
      agentId,
      vault: this.deps.vault,
      registry: this.deps.installedRegistry,
      catalog: this.deps.catalog,
      serviceRegistry: this.deps.serviceRegistry,
      nativeToolRegistry: this.deps.nativeToolRegistry,
      routeRegistry: this.deps.pluginRouteRegistry,
      notificationRouter: this.deps.notificationRouter,
      uiRouteCatalog: this.deps.uiRouteCatalog,
      jobScheduler: this.deps.jobScheduler,
    });

    const handle = await impl.activate(ctx, this.deps.coreApi);
    this.handles.set(agentId, handle);
    this.deps.routes.setActive(agentId, true);
    console.log(`[channels] ✓ activated ${agentId}`);
  }

  async deactivate(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    this.deps.routes.deactivateChannel(agentId);
    // Drop the cached ChannelPlugin implementation BEFORE the rest of
    // teardown so an immediately-following re-activate (upgrade flow)
    // can never observe the stale module. Without this, the resolver's
    // agentId-keyed cache hands back the old dist/plugin.js even though
    // a newer version was just unpacked at /data/uploaded-packages/.
    this.deps.resolver.invalidate?.(agentId);
    // Fail-safe: drop any uiRoute descriptors this plugin published.
    // Plugin close() should dispose its own handles, but a leaked one
    // would otherwise outlive its plugin in the catalogue and surface
    // a stale entry in channel-teams' Hub + Tab-Config dropdown.
    this.deps.uiRouteCatalog.disposeBySource(agentId);
    if (!handle) return;
    this.handles.delete(agentId);
    try {
      await handle.close();
      console.log(`[channels] · deactivated ${agentId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[channels] error closing ${agentId}:`,
        message,
      );
    }
    // Symmetric belt-and-braces with the other runtimes — see
    // toolPluginRuntime.ts for the rationale.
    this.deps.jobScheduler.stopForPlugin(agentId);
  }

  isActive(agentId: string): boolean {
    return this.handles.has(agentId);
  }

  activeIds(): string[] {
    return Array.from(this.handles.keys()).sort();
  }
}

// ---------------------------------------------------------------------------
// Fixed-imports resolver — swap for dynamic loader in Slice 2.5
// ---------------------------------------------------------------------------

/**
 * Static lookup of channel-id → ChannelPlugin implementation. Populate
 * entries as real channel packages land in the core. Slice 2.3 adds Teams;
 * Slice 2.4 adds Telegram; future slices swap this out for a dynamic loader
 * that reads `lifecycle.entry` from the catalog manifest and `import()`s.
 */
export class FixedChannelPluginResolver implements ChannelPluginResolver {
  private readonly impls = new Map<string, ChannelPlugin>();

  register(agentId: string, plugin: ChannelPlugin): void {
    this.impls.set(agentId, plugin);
  }

  resolve(agentId: string): ChannelPlugin | undefined {
    return this.impls.get(agentId);
  }

  registeredIds(): string[] {
    return Array.from(this.impls.keys()).sort();
  }
}
