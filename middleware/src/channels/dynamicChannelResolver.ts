import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { ChannelPlugin, ChannelPluginResolver } from '@omadia/channel-sdk';

import type { BuiltInPackageStore } from '../plugins/builtInPackageStore.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../plugins/manifestLoader.js';
import type { UploadedPackageStore } from '../plugins/uploadedPackageStore.js';

/**
 * Phase 5B — dynamic-import resolver for channel plugins.
 *
 * Mirrors the resolution path `ToolPluginRuntime` uses for tool /
 * extension / integration plugins:
 *   1. Look up the package source (uploaded → built-in fallback).
 *   2. Read `lifecycle.entry` from the catalog manifest (default
 *      `dist/plugin.js`).
 *   3. Verify the entry path stays inside the package root (defence
 *      against `..` traversal in the manifest).
 *   4. Dynamic-`import()` the file URL and return its `ChannelPlugin`
 *      export. Three export shapes are accepted in priority order:
 *        a. `module.activate` — the module itself is the plugin
 *           (matches `@omadia/integration-microsoft365`'s pattern).
 *        b. `module.default.activate` — default-export object
 *           shape.
 *        c. `module.default` — bare default-exported object whose
 *           `activate` lives on it.
 *
 * Resolution is async — `DefaultChannelRegistry.activate` awaits the
 * call so this resolver and the legacy `FixedChannelPluginResolver`
 * coexist behind the same interface.
 */

interface ChannelModuleShape {
  activate?: ChannelPlugin['activate'];
  default?:
    | ChannelPlugin
    | { activate?: ChannelPlugin['activate'] };
}

export interface DynamicChannelPluginResolverDeps {
  catalog: PluginCatalog;
  uploadedStore: UploadedPackageStore;
  builtInStore?: BuiltInPackageStore;
  log?: (msg: string) => void;
}

export class DynamicChannelPluginResolver implements ChannelPluginResolver {
  private readonly cache = new Map<string, ChannelPlugin>();

  constructor(private readonly deps: DynamicChannelPluginResolverDeps) {}

  async resolve(agentId: string): Promise<ChannelPlugin | undefined> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const catalogEntry = this.deps.catalog.get(agentId);
    if (!catalogEntry || catalogEntry.plugin.kind !== 'channel') {
      return undefined;
    }

    const packagePath = this.resolvePackagePath(agentId);
    if (!packagePath) {
      this.log(
        `[dynamic-channel-resolver] no package source for ${agentId} — uploadedStore + builtInStore both missing it`,
      );
      return undefined;
    }

    const entryRel = extractEntryPath(catalogEntry) ?? 'dist/plugin.js';
    const entryAbs = path.resolve(packagePath, entryRel);
    if (!entryAbs.startsWith(packagePath + path.sep)) {
      this.log(
        `[dynamic-channel-resolver] ${agentId}: entry path escapes package root (${entryRel}) — refusing import`,
      );
      return undefined;
    }
    try {
      await fs.access(entryAbs);
    } catch {
      this.log(
        `[dynamic-channel-resolver] ${agentId}: entry file not readable at ${entryAbs}`,
      );
      return undefined;
    }

    const mod = (await import(pathToFileURL(entryAbs).href)) as ChannelModuleShape;
    const impl = pickChannelPlugin(mod);
    if (!impl) {
      this.log(
        `[dynamic-channel-resolver] ${agentId}: ${entryAbs} exports no usable ChannelPlugin shape`,
      );
      return undefined;
    }

    this.cache.set(agentId, impl);
    return impl;
  }

  /** Eject a cached plugin entry — used when a channel is uninstalled or
   *  re-uploaded so a future activate() picks up the fresh module. */
  invalidate(agentId: string): void {
    this.cache.delete(agentId);
  }

  private resolvePackagePath(agentId: string): string | undefined {
    const uploaded = this.deps.uploadedStore.get(agentId);
    if (uploaded) return uploaded.path;
    return this.deps.builtInStore?.get(agentId)?.path;
  }

  private log(msg: string): void {
    (this.deps.log ?? ((m) => console.log(m)))(msg);
  }
}

function extractEntryPath(entry: PluginCatalogEntry): string | undefined {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  const lifecycle = manifest?.['lifecycle'] as Record<string, unknown> | undefined;
  const raw = lifecycle?.['entry'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function pickChannelPlugin(mod: ChannelModuleShape): ChannelPlugin | undefined {
  if (typeof mod.activate === 'function') {
    return { activate: mod.activate.bind(mod) };
  }
  const def = mod.default;
  if (def && typeof def === 'object') {
    if (typeof (def as ChannelPlugin).activate === 'function') {
      return def as ChannelPlugin;
    }
    const innerActivate = (def as { activate?: ChannelPlugin['activate'] })
      .activate;
    if (typeof innerActivate === 'function') {
      return { activate: innerActivate.bind(def) };
    }
  }
  return undefined;
}

/**
 * Composite resolver that tries every wrapped resolver in order and
 * returns the first non-undefined result. Useful while migrating
 * channels off the legacy fixed-imports path: register Dynamic first,
 * Fixed second, and the legacy registrations keep working until each
 * channel is refactored to source its deps from `ctx.services`.
 */
export class CompositeChannelPluginResolver implements ChannelPluginResolver {
  constructor(private readonly resolvers: ChannelPluginResolver[]) {}

  async resolve(agentId: string): Promise<ChannelPlugin | undefined> {
    for (const r of this.resolvers) {
      const hit = await r.resolve(agentId);
      if (hit) return hit;
    }
    return undefined;
  }
}
