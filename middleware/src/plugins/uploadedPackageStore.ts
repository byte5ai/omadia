import { promises as fs, type Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * File-backed index of uploaded agent packages.
 *
 * On-disk layout:
 *   <UPLOADED_PACKAGES_DIR>/
 *     index.json                       { version: 1, packages: Record<id, UploadedPackage> }
 *     <plugin-id>/<version>/           extracted package contents (manifest.yaml, dist/, …)
 *     <plugin-id>/.retired-<version>/  #1455 — the version a swap replaced, kept
 *                                      until the new one has activated
 *     .staging/<uuid>/                 staging during validation — renamed away on success
 *
 * The store is `register()`-write-only from the upload flow; reads happen
 * during the manifest-catalog merge and the UI list call. Atomic writes via
 * tmpfile + rename — mirrors the pattern in fileInstalledRegistry.
 */

/**
 * #1455 — prefix of the folder a replaced version is moved to instead of being
 * deleted outright. Dot-prefixed on purpose: the catalog is fed from this
 * store's index (`index.ts` → `extraSources`), never from a directory scan, and
 * the dot keeps the folder out of the way of any future scan as well.
 */
export const RETIRED_DIR_PREFIX: string = '.retired-';

/**
 * Remove every retired copy under `pluginDir`. Called before a new copy is
 * laid down (at most one is kept per plugin) and when the package is deleted —
 * otherwise an uninstall would leave an orphan nothing refers to, since the
 * store index points only at the live version.
 */
export async function pruneRetiredPackageDirs(pluginDir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(pluginDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RETIRED_DIR_PREFIX)) continue;
    await fs
      .rm(path.join(pluginDir, entry.name), { recursive: true, force: true })
      .catch(() => {});
  }
}

export interface UploadedPackage {
  id: string;
  version: string;
  /** Absolute path to the package root that contains `manifest.yaml`. */
  path: string;
  uploaded_at: string;
  uploaded_by: string;
  sha256: string;
  /** Required peer deps from package.json vs. host deps — warnings visible. */
  peers_missing: string[];
  /** Size of the uploaded zip in bytes (before extraction). */
  zip_bytes: number;
  /** Extracted total size in bytes. */
  extracted_bytes: number;
  /** Number of entries in the zip after filtering (excluding directories). */
  file_count: number;
}

interface StoreFile {
  version: 1;
  packages: Record<string, UploadedPackage>;
}

/**
 * #1455 — move a replaced package out of the way instead of deleting it, and
 * return where it went (null when the move failed, in which case the caller
 * simply has no rollback copy — never a failed ingest: the replacement is
 * already on disk at that point).
 *
 * At most one retired copy per plugin: any earlier one is pruned first, so a
 * run of upgrades cannot fill the packages volume. Lives here rather than in
 * the upload service because the layout it writes — `<id>/.retired-<version>`
 * next to `<id>/<version>` — is this module's to define.
 */
export async function retirePackageDir(
  replaced: UploadedPackage,
  log: (msg: string) => void,
): Promise<string | null> {
  const pluginDir = path.dirname(replaced.path);
  await pruneRetiredPackageDirs(pluginDir);
  const target = path.join(
    pluginDir,
    `${RETIRED_DIR_PREFIX}${path.basename(replaced.path)}`,
  );
  try {
    await fs.rename(replaced.path, target);
    return target;
  } catch (err) {
    // The folder is usually simply gone (the typical re-upload case: the
    // package was deleted and is being restored), which is nothing to fix.
    // Logged either way: the alternative is an operator who believes a
    // rollback copy exists because the feature promises one.
    log(
      `[upload] ${replaced.id}: no rollback copy — could not retire ${replaced.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export class UploadedPackageStore {
  private packages = new Map<string, UploadedPackage>();
  private loaded = false;

  constructor(
    private readonly indexPath: string,
    private readonly packagesDir: string,
    private readonly log: (msg: string) => void = (msg) => console.warn(msg),
  ) {}

  async load(): Promise<void> {
    await fs.mkdir(this.packagesDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || parsed.version !== 1 || typeof parsed.packages !== 'object') {
        throw new Error(`unexpected index format at ${this.indexPath}`);
      }
      this.packages.clear();
      for (const [id, pkg] of Object.entries(parsed.packages)) {
        this.packages.set(id, pkg);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      this.packages.clear();
    }
    this.loaded = true;
  }

  list(): UploadedPackage[] {
    this.assertLoaded();
    return Array.from(this.packages.values()).sort((a, b) =>
      a.id.localeCompare(b.id, 'de'),
    );
  }

  get(id: string): UploadedPackage | undefined {
    this.assertLoaded();
    return this.packages.get(id);
  }

  has(id: string): boolean {
    this.assertLoaded();
    return this.packages.has(id);
  }

  async register(pkg: UploadedPackage): Promise<void> {
    this.assertLoaded();
    this.packages.set(pkg.id, pkg);
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    this.assertLoaded();
    const pkg = this.packages.get(id);
    if (!pkg) return false;
    this.packages.delete(id);
    await this.persist();
    // Best-effort: remove the package dir. Errors are logged, but not thrown —
    // the registry entry is already gone. (#1490 — they were said to be
    // logged and were dropped.)
    await fs.rm(pkg.path, { recursive: true, force: true }).catch((err: unknown) => {
      this.log(
        `[upload] package ${id}: could not remove ${pkg.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // #1455 — and the retired sibling, which the index never pointed at.
    const pluginDir = path.dirname(pkg.path);
    await pruneRetiredPackageDirs(pluginDir);
    // #1490 — and the `<id>/` folder the version lived in, plus the
    // `@scope/` folder above it, when nothing else is left in them.
    await this.removeEmptyDirsUpTo(pluginDir);
    return true;
  }

  /**
   * Remove `dir` and its parents while they are empty, stopping at the
   * packages root. `rmdir` refuses a non-empty directory, which is the guard:
   * a scope folder that still holds another plugin stays. Only directories
   * strictly inside the root are touched — a stored path outside it (a
   * hand-edited index) is left alone.
   */
  private async removeEmptyDirsUpTo(dir: string): Promise<void> {
    const root = path.resolve(this.packagesDir);
    let current = path.resolve(dir);
    while (current.startsWith(root + path.sep)) {
      try {
        await fs.rmdir(current);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
          this.log(
            `[upload] could not remove empty package folder ${current}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (code !== 'ENOENT') return;
      }
      current = path.dirname(current);
    }
  }

  private async persist(): Promise<void> {
    const body: StoreFile = {
      version: 1,
      packages: Object.fromEntries(this.packages.entries()),
    };
    const dir = path.dirname(this.indexPath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(body, null, 2), 'utf-8');
    await fs.rename(tmp, this.indexPath);
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('UploadedPackageStore.load() must be called before use');
    }
  }
}

/**
 * Creates a symlink `node_modules → <host>/node_modules` at the packages root.
 *
 * Reason: uploaded packages declare `peerDependencies` (e.g. `zod`). On
 * dynamic `import(<pkg>/dist/plugin.js)`, Node's resolver walks up the dir
 * hierarchy looking for `node_modules/`. If the package lives under
 * `/data/uploaded-packages/...`, `/app/node_modules` is not structurally
 * reachable → `Cannot find package 'zod'`. A symlink at the packages root
 * bridges this for ALL sub-packages at once.
 *
 * Idempotent: an existing correct symlink is left alone; an incorrect symlink
 * or a real directory is NOT destroyed (hard error — that points at a
 * misconfiguration, not at a harmless stale state).
 */
export async function ensureHostNodeModulesLink(
  packagesDir: string,
): Promise<string> {
  const require = createRequire(import.meta.url);
  // `zod/package.json` is a stable peer-dep of the middleware; via its
  // path we learn where the host has its node_modules.
  let hostModulesRoot: string;
  try {
    const zodPkgPath = require.resolve('zod/package.json');
    hostModulesRoot = path.resolve(path.dirname(zodPkgPath), '..');
  } catch (err) {
    throw new Error(
      `cannot locate host node_modules via zod/package.json: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  await fs.mkdir(packagesDir, { recursive: true });
  const linkPath = path.join(packagesDir, 'node_modules');

  try {
    const stat = await fs.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const current = await fs.readlink(linkPath);
      const resolved = path.resolve(packagesDir, current);
      if (resolved === hostModulesRoot) return linkPath; // already correct
      await fs.unlink(linkPath);
    } else {
      throw new Error(
        `${linkPath} existiert bereits und ist kein Symlink — nicht überschreiben`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await fs.symlink(hostModulesRoot, linkPath, 'dir');
  return linkPath;
}
