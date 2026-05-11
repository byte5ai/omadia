import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MigrationHookError,
  MigrationTimeoutError,
} from '@omadia/plugin-api';

import type { InstalledRegistry } from './installedRegistry.js';
import type { PluginCatalog } from './manifestLoader.js';
import { loadManifestFromPath } from './manifestLoader.js';
import type { MigrationRunner } from './migrationRunner.js';
import type {
  UploadedPackageStore} from './uploadedPackageStore.js';
import {
  type UploadedPackage,
} from './uploadedPackageStore.js';
import { extractZipToDir, ZipExtractionError } from './zipExtractor.js';

/**
 * Nimmt ein uploaded Zip entgegen, validiert es und registriert den
 * enthaltenen Agent im UploadedPackageStore + Catalog.
 *
 * Nicht im MVP: AST-Import-Scan, Sandbox-Activation, Remote-Signature-Check.
 * Doku: docs/harness-platform/plans/agent-zip-upload.md
 */

export interface IngestInput {
  fileBuffer: Buffer;
  originalFilename: string;
  uploadedBy: string;
  /** SHA-256 des übergebenen Buffers; wird berechnet, wenn nicht angegeben. */
  sha256?: string;
}

export interface IngestSuccess {
  ok: true;
  package: UploadedPackage;
  plugin_id: string;
  version: string;
}

export interface IngestFailure {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
}

export type IngestResult = IngestSuccess | IngestFailure;

export interface PackageUploadServiceDeps {
  store: UploadedPackageStore;
  catalog: PluginCatalog;
  /** Absolute Pfade: Root für Uploads + Staging-Root + Index-Pfad (nur Logging). */
  packagesDir: string;
  /** Harte Caps aus der Config. */
  limits: {
    maxBytes: number;
    maxExtractedBytes: number;
    maxEntries: number;
  };
  /** Host-Dependencies für den peer-check (ReadonlyRecord<name, semver>). */
  hostDependencies: Record<string, string>;
  /**
   * Optionaler Hook. Wird nach erfolgreichem Ingest aufgerufen, wenn der
   * Registry-Eintrag für diesen Agenten bereits existiert und `active` ist
   * (typischer Re-Upload-Case: Package wurde gelöscht, Install-Status blieb).
   * Ermöglicht der Runtime, den Agenten direkt zu (re-)aktivieren, ohne dass
   * der User den Install-Flow noch einmal anstoßen muss.
   */
  onPackageReady?: (agentId: string) => Promise<void>;
  /**
   * Registry of installed agents. Required when `migrationRunner` is set —
   * the upload flow reads the previous config from here before invoking
   * `onMigrate` and writes back the new config + bumped version after a
   * successful hook run.
   */
  registry?: InstalledRegistry;
  /**
   * Runs the plugin's `onMigrate` hook during a version-change upload. Absent
   * in tests or bare-bones setups — in that case a version-change upload
   * carries the previous config over 1:1 (same opt-in semantics a plugin
   * without an `onMigrate` export would get).
   */
  migrationRunner?: MigrationRunner;
  log?: (msg: string) => void;
}

export class PackageUploadService {
  constructor(private readonly deps: PackageUploadServiceDeps) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    const log = this.deps.log ?? ((m) => console.log(m));

    if (input.fileBuffer.byteLength > this.deps.limits.maxBytes) {
      return fail(
        'package.too_large',
        `Upload überschreitet ${this.deps.limits.maxBytes} Bytes.`,
      );
    }

    const sha256 =
      input.sha256 ?? createHash('sha256').update(input.fileBuffer).digest('hex');

    // --- 1. Zip in Temp-Datei schreiben (yauzl will File-Path) ---------------
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-upload-'));
    const tmpZip = path.join(tmpRoot, 'package.zip');
    await fs.writeFile(tmpZip, input.fileBuffer);

    // --- 2. Staging-Verzeichnis ---------------------------------------------
    const stagingRoot = path.join(
      this.deps.packagesDir,
      '.staging',
      `${Date.now()}-${sha256.slice(0, 12)}`,
    );
    await fs.mkdir(stagingRoot, { recursive: true });

    try {
      // --- 3. Entpacken mit Guardrails --------------------------------------
      let extractResult;
      try {
        extractResult = await extractZipToDir(tmpZip, stagingRoot, {
          maxEntries: this.deps.limits.maxEntries,
          maxExtractedBytes: this.deps.limits.maxExtractedBytes,
        });
      } catch (err) {
        if (err instanceof ZipExtractionError) {
          return fail(err.code, err.message);
        }
        throw err;
      }

      const fileCount = extractResult.files.length;
      const extractedBytes = extractResult.totalBytes;

      // --- 4. Package-Root finden -------------------------------------------
      // Wenn das Zip unter einem Top-Level-Ordner gepackt wurde (z.B. `zip -r foo.zip folder`),
      // liegt manifest.yaml unter `<stagingRoot>/<wrapperDir>/manifest.yaml` statt direkt
      // im staging-root. Wir akzeptieren beide Varianten.
      const packageRoot = await resolvePackageRoot(stagingRoot);
      if (!packageRoot) {
        return fail(
          'package.manifest_missing',
          'Kein manifest.yaml im Zip-Root gefunden.',
        );
      }

      // --- 5. Manifest parsen + validieren ----------------------------------
      const manifestPath = path.join(packageRoot, 'manifest.yaml');
      const entry = await loadManifestFromPath(manifestPath);
      if (!entry) {
        return fail(
          'package.manifest_invalid',
          'manifest.yaml entspricht nicht dem schema_version "1".',
        );
      }
      const { plugin } = entry;

      // --- 6. package.json-Konsistenz ---------------------------------------
      const pkgJsonPath = path.join(packageRoot, 'package.json');
      let pkgJson: Record<string, unknown> | null = null;
      try {
        const raw = await fs.readFile(pkgJsonPath, 'utf-8');
        pkgJson = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          return fail(
            'package.package_json_invalid',
            `package.json konnte nicht gelesen werden: ${(err as Error).message}`,
          );
        }
      }

      if (pkgJson) {
        if (typeof pkgJson['name'] !== 'string' || pkgJson['name'] !== plugin.id) {
          return fail(
            'package.id_mismatch',
            `package.json.name (${String(pkgJson['name'])}) stimmt nicht mit manifest.identity.id (${plugin.id}) überein.`,
          );
        }
        if (
          typeof pkgJson['version'] !== 'string' ||
          pkgJson['version'] !== plugin.version
        ) {
          return fail(
            'package.version_mismatch',
            `package.json.version (${String(pkgJson['version'])}) stimmt nicht mit manifest.identity.version (${plugin.version}) überein.`,
          );
        }
      }

      // --- 7. Peer-Dependency-Resolve ---------------------------------------
      const peersMissing = this.resolvePeers(pkgJson);

      // --- 8. Entry-Point muss im Zip sein ----------------------------------
      const entryRel =
        (asRecord(asRecord(entry.manifest)?.['lifecycle'])?.['entry'] as
          | string
          | undefined) ?? 'dist/plugin.js';
      const absEntry = path.resolve(packageRoot, entryRel);
      if (!absEntry.startsWith(packageRoot + path.sep) || !(await fileExists(absEntry))) {
        return fail(
          'package.entry_missing',
          `lifecycle.entry '${entryRel}' ist im Zip nicht vorhanden.`,
        );
      }

      // --- 9. ID-Konflikt-Check --------------------------------------------
      const existingUploaded = this.deps.store.get(plugin.id);
      const catalogEntry = this.deps.catalog.get(plugin.id);
      if (catalogEntry && !existingUploaded) {
        return fail(
          'package.id_conflict_builtin',
          `Plugin-ID "${plugin.id}" kollidiert mit einem Built-in-Eintrag im Katalog.`,
        );
      }
      if (existingUploaded && existingUploaded.version === plugin.version) {
        return fail(
          'package.duplicate_version',
          `Version ${plugin.version} von ${plugin.id} ist bereits hochgeladen. Version anheben oder DELETE aufrufen.`,
        );
      }

      // --- 9b. Migration-Hook (onMigrate) ----------------------------------
      // Läuft nur bei echtem Version-Upgrade eines bereits im Registry
      // installierten Agents. Frische Uploads (kein Registry-Eintrag) oder
      // Re-Uploads derselben Version (oben abgefangen) triggern keine
      // Migration. Der Hook läuft BEVOR die Pakete getauscht werden — wirft
      // er, bleibt v1 unverändert und der Upload wird rejectet.
      const installedBefore = this.deps.registry?.get(plugin.id);
      const shouldMigrate =
        !!existingUploaded && !!installedBefore && existingUploaded.version !== plugin.version;
      let migratedConfig: Record<string, unknown> | null = null;
      if (shouldMigrate && this.deps.migrationRunner) {
        try {
          const result = await this.deps.migrationRunner.run({
            agentId: plugin.id,
            fromVersion: existingUploaded.version,
            toVersion: plugin.version,
            previousConfig: installedBefore.config,
            stagingPackageRoot: packageRoot,
            entryPath: entryRel,
            catalogEntry: entry,
          });
          migratedConfig = result.newConfig;
        } catch (err) {
          if (err instanceof MigrationTimeoutError) {
            return fail('package.migration_timeout', err.message);
          }
          if (err instanceof MigrationHookError) {
            return fail('package.migration_failed', err.message);
          }
          return fail(
            'package.migration_failed',
            `onMigrate-Lauf abgebrochen: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (shouldMigrate) {
        // Kein Runner injiziert (z.B. Bare-Bones-Setup) → wie Opt-in ohne Hook
        // handhaben: alte Config unverändert übernehmen, Version bumpen.
        migratedConfig = installedBefore.config;
      }

      // --- 10. Atomic rename in das finale Verzeichnis ----------------------
      const finalDir = path.join(
        this.deps.packagesDir,
        plugin.id,
        plugin.version,
      );
      await fs.mkdir(path.dirname(finalDir), { recursive: true });
      // Falls ein Restbestand einer abgebrochenen Installation liegt → weg.
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(packageRoot, finalDir);

      // Falls das Zip einen Wrapper-Ordner hatte, ist stagingRoot jetzt leer
      // (packageRoot war ein Child). Räumen.
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});

      // --- 11. Store-Eintrag + Catalog-Reload -------------------------------
      const pkgRecord: UploadedPackage = {
        id: plugin.id,
        version: plugin.version,
        path: finalDir,
        uploaded_at: new Date().toISOString(),
        uploaded_by: input.uploadedBy,
        sha256,
        peers_missing: peersMissing,
        zip_bytes: input.fileBuffer.byteLength,
        extracted_bytes: extractedBytes,
        file_count: fileCount,
      };

      // Wenn es einen früheren Upload mit anderer Version gab, alten Ordner
      // wegräumen. Ein side-by-side Layout erlauben wir erst mit Version-Switching-UI.
      if (existingUploaded && existingUploaded.path !== finalDir) {
        await fs
          .rm(existingUploaded.path, { recursive: true, force: true })
          .catch(() => {});
      }

      await this.deps.store.register(pkgRecord);
      await this.deps.catalog.load();

      // Commit the migration's config + version bump to the InstalledRegistry
      // after the package swap has succeeded. Doing this BEFORE swap would
      // leave an inconsistent state if the swap failed (registry says v2,
      // disk still has v1). Doing it AFTER swap means on failure between
      // store.register and updateVersion the registry drifts — but the
      // failures in that slice are local filesystem writes, not network I/O,
      // and leave the system recoverable (admin endpoint or next upload fixes
      // it). v2 package is already on disk, so no data loss.
      if (migratedConfig !== null && this.deps.registry) {
        await this.deps.registry.updateVersion(
          plugin.id,
          plugin.version,
          migratedConfig,
        );
      }

      log(
        `[upload] ingest OK id=${plugin.id} version=${plugin.version} sha256=${sha256.slice(0, 12)} peers_missing=${peersMissing.length}${migratedConfig !== null ? ' [migrated]' : ''}`,
      );

      // Re-Upload auf einen bereits installierten Agent (typisch: Package-
      // File wurde gelöscht, Registry-Eintrag ist noch `active`). Ohne Hook
      // bleibt der Agent „installed but inactive" — Tool wäre weder in
      // Harness noch in Teams sichtbar. Hook ist best-effort; Fehler werden
      // geloggt, brechen aber den Upload-Response nicht.
      if (this.deps.onPackageReady) {
        try {
          await this.deps.onPackageReady(plugin.id);
        } catch (err) {
          log(
            `[upload] onPackageReady hook failed for ${plugin.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        ok: true,
        package: pkgRecord,
        plugin_id: plugin.id,
        version: plugin.version,
      };
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  private resolvePeers(pkgJson: Record<string, unknown> | null): string[] {
    if (!pkgJson) return [];
    const peers = pkgJson['peerDependencies'];
    if (!peers || typeof peers !== 'object') return [];
    const missing: string[] = [];
    for (const name of Object.keys(peers as Record<string, unknown>)) {
      if (!this.deps.hostDependencies[name]) {
        missing.push(name);
      }
    }
    return missing;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function resolvePackageRoot(stagingRoot: string): Promise<string | null> {
  if (await fileExists(path.join(stagingRoot, 'manifest.yaml'))) {
    return stagingRoot;
  }
  const entries = await fs.readdir(stagingRoot, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    const sub = dirs[0];
    if (!sub) return null;
    const candidate = path.join(stagingRoot, sub.name);
    if (await fileExists(path.join(candidate, 'manifest.yaml'))) {
      return candidate;
    }
  }
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function fail(code: string, message: string, details?: unknown): IngestFailure {
  const out: IngestFailure = { ok: false, code, message };
  if (details !== undefined) out.details = details;
  return out;
}
