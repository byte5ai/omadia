import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadManifestFromPath } from './manifestLoader.js';

/**
 * Optional source for plugin authors iterating outside the workspace.
 *
 * Activated via the `PLUGIN_DEV_DIR` env-var: when set, every direct sub-
 * directory that contains a valid schema-v1 `manifest.yaml` is exposed as
 * a plugin source — same shape as `BuiltInPackageStore` and the uploaded-
 * package source. Default is **unset** (= disabled), so the OSS-shipping
 * state has no implicit dev override.
 *
 * Resolution order in `PluginCatalog`:
 *   `Local-Dev > Uploaded > Built-in > PLUGIN_MANIFEST_DIR (examples)`
 *
 * Local-Dev wins so a plugin author can shadow a built-in or uploaded
 * package with the same id from their own working tree without packing-
 * zipping-uploading every iteration. ZIP-upload remains the canonical
 * runtime install path; this store is strictly a dev-loop accelerator.
 *
 * Layout on disk:
 *   <PLUGIN_DEV_DIR>/<package-name>/manifest.yaml
 *
 * Subdirectories without a `manifest.yaml` are skipped (mirrors the
 * built-in store: e.g. a `shared-types` workspace package is ignored).
 * A missing `PLUGIN_DEV_DIR` directory is tolerated — `load()` returns
 * an empty list rather than failing the boot.
 */

export interface LocalDevPackage {
  id: string;
  version: string;
  /** Absolute path to the package root (contains `manifest.yaml`). */
  path: string;
}

export class LocalDevPackageStore {
  private packages = new Map<string, LocalDevPackage>();
  private loaded = false;
  private readonly devDir: string | undefined;

  constructor(devDir: string | undefined) {
    // `undefined` / empty disables the source entirely. Any other value is
    // resolved to absolute so downstream consumers can do the same boundary
    // checks as for built-ins (`path.resolve(...).startsWith(packagePath)`).
    this.devDir = devDir && devDir.trim().length > 0 ? path.resolve(devDir) : undefined;
  }

  async load(): Promise<void> {
    this.packages.clear();
    if (!this.devDir) {
      this.loaded = true;
      return;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(this.devDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw err;
    }

    for (const name of entries) {
      const packageRoot = path.join(this.devDir, name);
      const stat = await fs.stat(packageRoot).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const manifestPath = path.join(packageRoot, 'manifest.yaml');
      try {
        await fs.access(manifestPath);
      } catch {
        continue;
      }

      const entry = await loadManifestFromPath(manifestPath);
      if (!entry) {
        console.warn(
          `[plugin-dev] skipped ${packageRoot}: manifest.yaml present but not a valid schema-v1 document`,
        );
        continue;
      }

      this.packages.set(entry.plugin.id, {
        id: entry.plugin.id,
        version: entry.plugin.version,
        path: packageRoot,
      });
    }

    this.loaded = true;
  }

  /** True when `PLUGIN_DEV_DIR` was set to a non-empty value. */
  enabled(): boolean {
    return this.devDir !== undefined;
  }

  /** Absolute path the store was configured with, or `undefined` if disabled. */
  rootPath(): string | undefined {
    return this.devDir;
  }

  list(): LocalDevPackage[] {
    this.ensureLoaded();
    return Array.from(this.packages.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  get(id: string): LocalDevPackage | undefined {
    this.ensureLoaded();
    return this.packages.get(id);
  }

  has(id: string): boolean {
    this.ensureLoaded();
    return this.packages.has(id);
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error(
        'LocalDevPackageStore: call load() before any other operation',
      );
    }
  }
}
