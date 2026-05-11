import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * File-backed Index hochgeladener Agent-Packages.
 *
 * Layout auf der Platte:
 *   <UPLOADED_PACKAGES_DIR>/
 *     index.json                       { version: 1, packages: Record<id, UploadedPackage> }
 *     <plugin-id>/<version>/           entpackter Package-Inhalt (manifest.yaml, dist/, …)
 *     .staging/<uuid>/                 Staging während der Validierung — nach Erfolg per rename weg
 *
 * Der Store ist `register()`-write-only aus dem Upload-Flow; gelesen wird
 * beim Manifest-Catalog-Merge und beim UI-List-Call. Atomic writes via
 * tmpfile + rename — spiegelt das Muster aus fileInstalledRegistry.
 */

export interface UploadedPackage {
  id: string;
  version: string;
  /** Absoluter Pfad zum Package-Root, das `manifest.yaml` enthält. */
  path: string;
  uploaded_at: string;
  uploaded_by: string;
  sha256: string;
  /** Pflicht-Peer-Deps aus package.json vs. Host-Deps — Warnungen sichtbar. */
  peers_missing: string[];
  /** Größe des hochgeladenen Zips in Bytes (vor Entpacken). */
  zip_bytes: number;
  /** Entpackte Gesamtgröße in Bytes. */
  extracted_bytes: number;
  /** Anzahl Einträge im Zip nach Filter (ohne Verzeichnisse). */
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
    // Best-effort: Package-Dir löschen. Fehler werden geloggt, aber nicht geworfen —
    // der Registry-Eintrag ist schon weg.
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
 * Legt im Packages-Root einen Symlink `node_modules → <host>/node_modules` an.
 *
 * Grund: hochgeladene Packages deklarieren `peerDependencies` (z.B. `zod`).
 * Beim dynamischen `import(<pkg>/dist/plugin.js)` läuft Nodes Resolver die
 * Dir-Hierarchie nach oben und sucht `node_modules/`. Liegt das Paket unter
 * `/data/uploaded-packages/...`, ist `/app/node_modules` strukturell nicht
 * erreichbar → `Cannot find package 'zod'`. Ein Symlink an der Packages-Root
 * schlägt die Brücke für ALLE Unter-Packages auf einmal.
 *
 * Idempotent: bestehender korrekter Symlink wird gelassen; falscher Symlink
 * oder echtes Verzeichnis wird NICHT zerstört (hartes Error — das deutet auf
 * Fehlkonfiguration hin, nicht auf einen harmlosen Altzustand).
 */
export async function ensureHostNodeModulesLink(
  packagesDir: string,
): Promise<string> {
  const require = createRequire(import.meta.url);
  // `zod/package.json` ist eine stabile Peer-Dep der Middleware; über ihren
  // Pfad lernen wir, wo der Host seine node_modules liegen hat.
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
