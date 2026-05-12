import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * File-backed index of uploaded agent packages.
 *
 * On-disk layout:
 *   <UPLOADED_PACKAGES_DIR>/
 *     index.json                       { version: 1, packages: Record<id, UploadedPackage> }
 *     <plugin-id>/<version>/           extracted package contents (manifest.yaml, dist/, …)
 *     .staging/<uuid>/                 staging during validation — renamed away on success
 *
 * The store is `register()`-write-only from the upload flow; reads happen
 * during the manifest-catalog merge and the UI list call. Atomic writes via
 * tmpfile + rename — mirrors the pattern in fileInstalledRegistry.
 */

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

export class UploadedPackageStore {
  private packages = new Map<string, UploadedPackage>();
  private loaded = false;

  constructor(
    private readonly indexPath: string,
    private readonly packagesDir: string,
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
    // the registry entry is already gone.
    await fs.rm(pkg.path, { recursive: true, force: true }).catch(() => {});
    return true;
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
