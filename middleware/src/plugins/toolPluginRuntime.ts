import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';

import { createPluginContext } from '../platform/pluginContext.js';
import type { PluginRouteRegistry } from '../platform/pluginRouteRegistry.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';
import type { SecretVault } from '../secrets/vault.js';
import type { NativeToolRegistry } from '@omadia/orchestrator';
import type { BuiltInPackageStore } from './builtInPackageStore.js';
import { resolveEligiblePlugins } from './capabilityResolver.js';
import type { InstalledRegistry } from './installedRegistry.js';
import type { JobScheduler } from './jobScheduler.js';
import type { PluginCatalog, PluginCatalogEntry } from './manifestLoader.js';
import { topoSortByDependsOn } from './topoSort.js';
import type { UploadedPackageStore } from './uploadedPackageStore.js';

/**
 * Runtime for `kind: tool`, `kind: extension`, and `kind: integration`
 * plugins.
 *
 * Tool / extension / integration plugins don't expose a toolkit like
 * agent plugins do — their `activate(ctx)` registers into the kernel's
 * native-tool / route / turn-hook / job / service registries during the
 * call and returns a close-only handle. The runtime's responsibilities
 * are thinner than DynamicAgentRuntime's: dynamic-import, invoke
 * activate with timeout, remember the handle so deactivate can call
 * close().
 *
 * Idempotent across boots: if a plugin's activate() throws repeatedly, the
 * InstalledRegistry circuit-breaker flips status to 'errored' and
 * activateAllInstalled skips it.
 */

interface ToolPluginHandle {
  close(): Promise<void>;
}

interface ToolPluginModuleShape {
  activate?: (ctx: unknown) => Promise<ToolPluginHandle>;
  default?: {
    activate?: (ctx: unknown) => Promise<ToolPluginHandle>;
  };
}

interface ActiveEntry {
  agentId: string;
  handle: ToolPluginHandle;
}

export interface ToolPluginRuntimeDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  vault: SecretVault;
  uploadedStore: UploadedPackageStore;
  builtInStore?: BuiltInPackageStore;
  serviceRegistry: ServiceRegistry;
  nativeToolRegistry: NativeToolRegistry;
  pluginRouteRegistry: PluginRouteRegistry;
  jobScheduler: JobScheduler;
  log?: (msg: string) => void;
}

export class ToolPluginRuntime {
  private readonly active = new Map<string, ActiveEntry>();

  constructor(private readonly deps: ToolPluginRuntimeDeps) {}

  /** Activates every tool- or extension-kind package that the registry
   *  marks as active. Fails per-plugin (logs + circuit-breaker) rather
   *  than failing the whole boot. */
  async activateAllInstalled(): Promise<void> {
    const log = this.deps.log ?? ((m) => console.log(m));

    const ids = new Set<string>();
    for (const pkg of this.deps.uploadedStore.list()) ids.add(pkg.id);
    if (this.deps.builtInStore) {
      for (const pkg of this.deps.builtInStore.list()) ids.add(pkg.id);
    }

    // Pre-filter to tool/extension candidates that are registry-active, then
    // topologically sort so a plugin's dependencies activate first. Cross-
    // runtime deps (agent→tool) are handled by the outer boot order in
    // index.ts — this runtime runs before the agent runtime.
    const eligible: string[] = [];
    for (const id of ids) {
      const catalogEntry = this.deps.catalog.get(id);
      if (!catalogEntry) continue;
      if (
        catalogEntry.plugin.kind !== 'tool' &&
        catalogEntry.plugin.kind !== 'extension' &&
        catalogEntry.plugin.kind !== 'integration'
      ) {
        continue;
      }
      const reg = this.deps.registry.get(id);
      if (!reg || reg.status !== 'active') continue;
      eligible.push(id);
    }

    // Resolve capabilities BEFORE topo-sorting. Two guarantees land here:
    //   (1) implicit provider→consumer edges flow into topoSort so that
    //       `ctx.services.get(<cap>)` inside a consumer's activate() sees
    //       the provider's service already registered;
    //   (2) consumers whose `requires` cannot be satisfied by the
    //       eligible set are dropped and marked errored — the boot does
    //       not abort, the unresolved plugin surfaces in the UI with an
    //       actionable message, and the operator can install the
    //       missing provider via the wizard.
    const resolution = resolveEligiblePlugins(eligible, this.deps.catalog);

    for (const u of resolution.unresolved) {
      const msg = `unresolved capability requires: ${u.requires.join(', ')}`;
      log(`[tool-runtime] ${u.consumerId} not activated — ${msg}`);
      try {
        // Persist the raw `requires:` list alongside the error so the
        // bootstrap retry-loop on next boot can re-check resolvability
        // without re-running the resolver itself (S+8.5 sub-commit 3).
        await this.deps.registry.markActivationFailed(
          u.consumerId,
          msg,
          u.requires,
        );
      } catch (regErr) {
        log(
          `[tool-runtime] registry markActivationFailed FAILED for ${u.consumerId}: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
        );
      }
    }

    const sorted = topoSortByDependsOn(
      resolution.resolved,
      this.deps.catalog,
      resolution.edges,
    );

    for (const id of sorted) {
      try {
        await this.activate(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[tool-runtime] activate FAILED for ${id}: ${msg}`);
        try {
          await this.deps.registry.markActivationFailed(id, msg);
        } catch (regErr) {
          log(
            `[tool-runtime] registry markActivationFailed FAILED for ${id}: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
          );
        }
      }
    }
  }

  /** Activate a single tool/extension plugin. Idempotent — returns early
   *  if the plugin is already active. */
  async activate(agentId: string): Promise<void> {
    const log = this.deps.log ?? ((m) => console.log(m));
    if (this.active.has(agentId)) return;

    const packagePath = this.resolvePackagePath(agentId);
    if (!packagePath) {
      throw new Error(`tool-runtime: no package source for '${agentId}'`);
    }
    const catalogEntry = this.deps.catalog.get(agentId);
    if (!catalogEntry) {
      throw new Error(`tool-runtime: ${agentId} not in plugin catalog`);
    }

    const entryRel = extractEntryPath(catalogEntry) ?? 'dist/plugin.js';
    const entryAbs = path.resolve(packagePath, entryRel);
    if (!entryAbs.startsWith(packagePath + path.sep)) {
      throw new Error(
        `tool-runtime: entry path escapes package root (${entryRel})`,
      );
    }
    await fs.access(entryAbs).catch(() => {
      throw new Error(`tool-runtime: entry file not readable at ${entryAbs}`);
    });

    const mod = (await import(pathToFileURL(entryAbs).href)) as ToolPluginModuleShape;
    const activateFn = mod.activate ?? mod.default?.activate;
    if (typeof activateFn !== 'function') {
      throw new Error(
        `tool-runtime: ${entryAbs} exports neither activate() nor default.activate()`,
      );
    }

    const ctx = createPluginContext({
      agentId,
      vault: this.deps.vault,
      registry: this.deps.registry,
      catalog: this.deps.catalog,
      serviceRegistry: this.deps.serviceRegistry,
      nativeToolRegistry: this.deps.nativeToolRegistry,
      routeRegistry: this.deps.pluginRouteRegistry,
      jobScheduler: this.deps.jobScheduler,
      logger: (...args) => console.log(`[${agentId}]`, ...args),
    });

    const handle = await withTimeout(
      activateFn(ctx),
      10_000,
      `activate(${agentId}) timed out after 10s`,
    );

    this.active.set(agentId, { agentId, handle });

    try {
      await this.deps.registry.markActivationSucceeded(agentId);
    } catch (err) {
      log(
        `[tool-runtime] registry markActivationSucceeded FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log(
      `[tool-runtime] ACTIVATED ${agentId} (${catalogEntry.plugin.kind}, entry=${entryRel})`,
    );
  }

  async deactivate(agentId: string): Promise<boolean> {
    const log = this.deps.log ?? ((m) => console.log(m));
    const entry = this.active.get(agentId);
    if (!entry) return false;
    try {
      await withTimeout(
        entry.handle.close(),
        5_000,
        `close(${agentId}) timed out after 5s`,
      );
    } catch (err) {
      log(
        `[tool-runtime] close FAILED for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Bulk-stop any background jobs the plugin registered. Belt-and-braces
    // alongside the per-registration dispose handles that the plugin's own
    // close() should already invoke — a leaked dispose still won't outlive
    // its plugin's lifecycle.
    this.deps.jobScheduler.stopForPlugin(agentId);
    this.active.delete(agentId);
    log(`[tool-runtime] DEACTIVATED ${agentId}`);
    return true;
  }

  isActive(agentId: string): boolean {
    return this.active.has(agentId);
  }

  activeIds(): string[] {
    return Array.from(this.active.keys());
  }

  private resolvePackagePath(agentId: string): string | undefined {
    const uploaded = this.deps.uploadedStore.get(agentId);
    if (uploaded) return uploaded.path;
    return this.deps.builtInStore?.get(agentId)?.path;
  }
}

function extractEntryPath(entry: PluginCatalogEntry): string | undefined {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const lifecycle = manifest?.['lifecycle'] as Record<string, unknown> | undefined;
  const raw = lifecycle?.['entry'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
