import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadManifestFromPath } from './manifestLoader.js';

/**
 * Scans `middleware/packages/*` at boot, treats every sub-directory that
 * contains a valid schema-v1 `manifest.yaml` as a built-in plugin package,
 * and exposes them via the same shape as the UploadedPackageStore.
 *
 * Built-ins are the bridge between "pure kernel" and "uploaded plugins":
 * they ship inside the middleware image but go through the exact same
 * activation pathway (DynamicAgentRuntime.activate → dynamic-import → hook).
 * This lets us extract features out of the monolith one at a time without
 * breaking the deploy — the feature still boots, just via the plugin path.
 *
 * Packages without a manifest.yaml (e.g. `packages/plugin-api` which is the
 * shared-types package itself, not a plugin) are skipped. Invalid manifests
 * are skipped with a warning rather than failing the boot — a broken
 * built-in should not take the whole host offline, the same way a broken
 * uploaded package doesn't.
 */

export interface BuiltInPackage {
  id: string;
  version: string;
  /** Absolute path to the package root (contains `manifest.yaml`). */
  path: string;
}

export class BuiltInPackageStore {
  private packages = new Map<string, BuiltInPackage>();
  private loaded = false;
  private readonly packagesDir: string;

  constructor(packagesDir: string) {
    // Resolve to absolute so downstream consumers (DynamicAgentRuntime,
    // ToolPluginRuntime) can do `path.resolve(packagePath, entryRel)
    // .startsWith(packagePath + sep)` boundary checks without the
    // relative-vs-absolute mismatch that false-positives entry-path-escape
    // errors. Config default is `./packages` which resolves relative to
    // the process CWD at construction time — fine because the middleware
    // always launches from its own root.
    this.packagesDir = path.resolve(packagesDir);
  }

  async load(): Promise<void> {
    this.packages.clear();
    let entries: string[];
    try {
      entries = await fs.readdir(this.packagesDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw err;
    }

    for (const name of entries) {
      const packageRoot = path.join(this.packagesDir, name);
      const stat = await fs.stat(packageRoot).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const manifestPath = path.join(packageRoot, 'manifest.yaml');
      try {
        await fs.access(manifestPath);
      } catch {
        // No manifest → not a plugin package (e.g. plugin-api shared types).
        continue;
      }

      const entry = await loadManifestFromPath(manifestPath);
      if (!entry) {
        console.warn(
          `[builtin] skipped ${packageRoot}: manifest.yaml present but not a valid schema-v1 document`,
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

  list(): BuiltInPackage[] {
    this.ensureLoaded();
    return Array.from(this.packages.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  get(id: string): BuiltInPackage | undefined {
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
        'BuiltInPackageStore: call load() before any other operation',
      );
    }
  }
}
