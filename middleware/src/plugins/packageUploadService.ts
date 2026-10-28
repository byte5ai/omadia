import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MigrationHookError,
  MigrationTimeoutError,
} from '@omadia/plugin-api';

import { findUnscannableSegment } from '../services/pluginScanner.js';
import {
  versionDirection,
  type VersionChangeDirection,
} from './versionDirection.js';
import type { PluginActivationResult } from '../api/admin-v1.js';
import {
  activationResultOf,
  describeActivationFailure,
  type ActivationFailure,
} from './activationFailure.js';
import { checkCoreCompat } from './coreCompat.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  recordActivationFailure,
  recordActivationSuccess,
  type InstalledRegistry,
} from './installedRegistry.js';
import type { PluginCatalog } from './manifestLoader.js';
import { loadManifestFromPath } from './manifestLoader.js';
import type { MigrationRunner } from './migrationRunner.js';
import {
  retirePackageDir,
  type UploadedPackage,
  type UploadedPackageStore,
} from './uploadedPackageStore.js';
import { extractZipToDir, ZipExtractionError } from './zipExtractor.js';
import {
  formatArbitraryValueOffenders,
  scanForArbitraryTailwindValues,
} from './tailwindArbitraryValueScan.js';

/**
 * Accepts an uploaded zip, validates it and registers the contained agent
 * in the UploadedPackageStore + catalog.
 *
 * Out of scope for MVP: AST import scan, sandboxed activation, remote
 * signature check.
 * Docs: docs/harness-platform/plans/agent-zip-upload.md
 */

export interface IngestInput {
  fileBuffer: Buffer;
  originalFilename: string;
  uploadedBy: string;
  /** SHA-256 of the supplied buffer; computed when not provided. */
  sha256?: string;
  /**
   * #1455 — the caller's explicit consent to install a version that is OLDER
   * than the one currently in the store. Absent or false, such an ingest is
   * refused with `package.downgrade_blocked`.
   *
   * A request flag rather than an env var (unlike the bundled-id override at
   * `ALLOW_BUNDLED_ID_OVERRIDE`): a downgrade harms nothing but the operator's
   * own running plugin, and the decision belongs to whoever is pressing the
   * button — it is a confirmation, not a privilege.
   */
  allowDowngrade?: boolean;
}

export interface IngestSuccess {
  ok: true;
  package: UploadedPackage;
  plugin_id: string;
  version: string;
  /** #1455 — set only when this ingest replaced another version of the same
   *  plugin, so a caller can report the swap in the direction it happened.
   *  Absent on a first upload. */
  direction?: VersionChangeDirection;
  /**
   * #1452 — the `onPackageReady` hook threw: the package is ingested, the
   * plugin is NOT running, and this is why. The registry entry has been
   * flipped to `errored` with the same message.
   *
   * Absence is deliberately not a positive "it is running" claim — this seam
   * cannot make one. The host hook returns early for a plugin that is not
   * installed-and-active (a fresh ingest goes through the install flow, which
   * reports activation itself), so an `ok` field would read as "activated" for
   * every upload that never attempted an activation.
   */
  activation_error?: string;
  /** #1497 — the shared activation result (`PluginActivationResult`), present
   *  only when this ingest (re)activated an installed plugin. Same absence
   *  rule as `activation_error`. */
  activation?: PluginActivationResult;
}

export interface IngestFailure {
  ok: false;
  code: string;
  /** Display text in one fixed language — the upload has no request locale. */
  message: string;
  details?: unknown;
  /**
   * #1401 — the values a client needs to render `code` in the operator's
   * locale (e.g. `{ pluginId, version }` for `package.duplicate_version`).
   */
  params?: Record<string, string>;
}

export type IngestResult = IngestSuccess | IngestFailure;

/**
 * Refusals that are about the STATE of this host rather than about the package:
 * the zip is well-formed and the request answerable, but an id is taken or a
 * version already sits there. Routes answer these 409, which is why the set
 * lives with the codes rather than in each route (#1455 added the fourth one
 * and had to touch three places to do it).
 *
 * `package.incompatible_core` is deliberately absent: the builder maps it to a
 * reason of its own, and merging the two would change that route's status.
 */
export const INGEST_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'package.id_conflict_builtin',
  'package.id_conflict_bundled',
  'package.duplicate_version',
  'package.downgrade_blocked',
]);

export interface PackageUploadServiceDeps {
  store: UploadedPackageStore;
  catalog: PluginCatalog;
  /** Absolute paths: root for uploads + staging-root + index-path (logging only). */
  packagesDir: string;
  /** Hard caps from config. */
  limits: {
    maxBytes: number;
    maxExtractedBytes: number;
    maxEntries: number;
  };
  /** Host dependencies for the peer-check (ReadonlyRecord<name, semver>). */
  hostDependencies: Record<string, string>;
  /**
   * This host's `@omadia/plugin-api` version, which the package's
   * `compat.core` must admit. Default: read from the installed package
   * (coreCompat.ts). Tests pin it.
   */
  hostPluginApiVersion?: string;
  /**
   * Optional hook that (re)activates the plugin after a successful ingest.
   * Called only when `shouldReactivate` says this ingest landed on a plugin
   * the host is supposed to be running — an `active` entry (the update /
   * re-upload case this exists for) or an `errored` one below the
   * circuit-breaker threshold (so a fixed version can recover it). Not called
   * for `inactive`, for a latched/blocked entry, or for a plugin that is not
   * installed, whose activation the install flow owns. Without a `registry`
   * dep there is nothing to gate on and the hook always runs.
   *
   * #1452 — THE HOOK'S VERDICT IS RECORDED. Returning normally is written to
   * the registry as "this plugin is running" (`recordActivationSuccess`), a
   * throw as `errored` plus the message (`recordActivationFailure`), and the
   * throw also travels back to the caller in `IngestSuccess.activation_error`.
   * So an implementation must throw rather than return early whenever it did
   * not actually activate — see the channel branch in index.ts, which asserts
   * `isActive` afterwards because `channelRegistry.activate()` only warns when
   * the package exports no usable plugin.
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
  /**
   * Optional code-scan scheduler (issue #453). Invoked fire-and-forget on
   * the ingest success path — a missing scheduler, a scheduler throw, or a
   * scanner outage must never fail or delay an ingest (advisory-only v1).
   * Structural slice of `PluginScanScheduler` in services/pluginVerdict.ts.
   */
  scanScheduler?: {
    scheduleScan(input: {
      sha256: string;
      pluginId: string;
      installedDir: string;
    }): Promise<void>;
  };
  log?: (msg: string) => void;
}

/**
 * #789 — the operator's explicit opt-out from the bundled-id refusal.
 *
 * An env var rather than a request flag on purpose: the refusal protects the
 * host from the package, so the permission has to come from the person who
 * runs the host, not from whoever is holding the zip. A request parameter
 * would let the uploader authorise their own override, which is the shape of
 * the bug this closes rather than a fix for it.
 *
 * Read per call rather than captured at module load, so a test — or an
 * operator restarting with the flag set — does not depend on import order.
 */
const BUNDLED_ID_OVERRIDE_ENV = 'PLUGIN_ALLOW_BUNDLED_ID_OVERRIDE';

/** Exactly `'1'`. A bare `true`/`yes` does not count: one spelling means one
 *  thing to grep for during an incident, and no near-miss silently disarms
 *  the gate. */
function allowBundledIdOverride(): boolean {
  return process.env[BUNDLED_ID_OVERRIDE_ENV] === '1';
}

export class PackageUploadService {
  constructor(private readonly deps: PackageUploadServiceDeps) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    const log = this.deps.log ?? ((m) => console.log(m));

    if (input.fileBuffer.byteLength > this.deps.limits.maxBytes) {
      return fail(
        'package.too_large',
        `Upload überschreitet ${this.deps.limits.maxBytes} Bytes.`,
        undefined,
        { maxBytes: String(this.deps.limits.maxBytes) },
      );
    }

    const sha256 =
      input.sha256 ?? createHash('sha256').update(input.fileBuffer).digest('hex');

    // --- 1. Zip in Temp-Datei schreiben (yauzl will File-Path) ---------------
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-upload-'));
    const tmpZip = path.join(tmpRoot, 'package.zip');
    await fs.writeFile(tmpZip, input.fileBuffer);

    // --- 2. Staging directory ---------------------------------------------
    const stagingRoot = path.join(
      this.deps.packagesDir,
      '.staging',
      `${Date.now()}-${sha256.slice(0, 12)}`,
    );
    await fs.mkdir(stagingRoot, { recursive: true });

    try {
      // --- 3. Extract with guardrails ---------------------------------------
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

      // --- 4. Find package root ---------------------------------------------
      // If the zip was packed under a top-level folder (e.g. `zip -r foo.zip folder`),
      // manifest.yaml lives at `<stagingRoot>/<wrapperDir>/manifest.yaml` instead of
      // directly in the staging root. We accept both variants.
      const packageRoot = await resolvePackageRoot(stagingRoot);
      if (!packageRoot) {
        return fail(
          'package.manifest_missing',
          'Kein manifest.yaml im Zip-Root gefunden.',
        );
      }

      // --- 5. Parse + validate manifest -------------------------------------
      const manifestPath = path.join(packageRoot, 'manifest.yaml');
      const entry = await loadManifestFromPath(manifestPath);
      if (!entry) {
        return fail(
          'package.manifest_invalid',
          'manifest.yaml entspricht nicht dem schema_version "1".',
        );
      }
      const { plugin } = entry;

      // --- 5b. compat.core must admit this host's plugin-api -----------------
      // A plugin links against THIS host's @omadia/plugin-api at runtime;
      // outside its stated range it may import an export the host lacks and
      // fail to load. Refused before anything is stored.
      const coreRefusal = checkCoreCompat(plugin, this.deps.hostPluginApiVersion);
      if (coreRefusal) {
        return fail('package.incompatible_core', coreRefusal.message, {
          compat_core: coreRefusal.compat_core,
          host_plugin_api: coreRefusal.host_plugin_api,
        });
      }

      // --- 6. package.json consistency --------------------------------------
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
            undefined,
            { packageName: String(pkgJson['name']), pluginId: plugin.id },
          );
        }
        if (
          typeof pkgJson['version'] !== 'string' ||
          pkgJson['version'] !== plugin.version
        ) {
          return fail(
            'package.version_mismatch',
            `package.json.version (${String(pkgJson['version'])}) stimmt nicht mit manifest.identity.version (${plugin.version}) überein.`,
            undefined,
            { packageVersion: String(pkgJson['version']), pluginVersion: plugin.version },
          );
        }
      }

      // --- 7. Peer dependency resolution ------------------------------------
      const peersMissing = this.resolvePeers(pkgJson);

      // --- 8. Entry point must exist in the zip -----------------------------
      const entryRel =
        (asRecord(asRecord(entry.manifest)?.['lifecycle'])?.['entry'] as
          | string
          | undefined) ?? 'dist/plugin.js';
      const absEntry = path.resolve(packageRoot, entryRel);
      if (!absEntry.startsWith(packageRoot + path.sep) || !(await fileExists(absEntry))) {
        return fail(
          'package.entry_missing',
          `lifecycle.entry '${entryRel}' ist im Zip nicht vorhanden.`,
          undefined,
          { entry: entryRel },
        );
      }
      // #453 (codex review fix) — the code scan skips node_modules/.git, so
      // an entry point below such a path would EXECUTE code the scanner
      // never saw while the store shows a clean badge. No legitimate omadia
      // plugin does this (the boilerplate uses dist/plugin.js) → reject.
      const unscannable = findUnscannableSegment(
        path.relative(packageRoot, absEntry),
      );
      if (unscannable !== null) {
        return fail(
          'package.entry_unscannable',
          `lifecycle.entry '${entryRel}' liegt unter '${unscannable}' — Entry Points unter node_modules oder versteckten Verzeichnissen sind nicht erlaubt (der Code-Scan würde sie nicht erfassen).`,
        );
      }

      // --- 8b. UI bundle: no arbitrary Tailwind values ----------------------
      // Epic #470 C8. A plugin's `ui/` bundle styles itself exclusively from
      // the stylesheet core generates and serves, which carries a finite,
      // documented vocabulary. A class outside it renders unstyled and says
      // nothing about why, so an arbitrary value is rejected here, where the
      // answer can name the file and the line. `tailwindArbitraryValueScan.ts`
      // documents the two patterns and their known limits.
      const uiOffenders = scanForArbitraryTailwindValues(
        await readUiBundleScripts(packageRoot),
      );
      if (uiOffenders.length > 0) {
        return fail(
          'package.ui_arbitrary_tailwind_value',
          'The ui/ bundle uses Tailwind arbitrary values. Plugins may only use the ' +
            'vocabulary core pre-generates (see plugin-ui-vocabulary.md in the ' +
            'epic #470 spec directory); an undeclared class renders unstyled.\n' +
            formatArbitraryValueOffenders(uiOffenders),
          { offenders: uiOffenders },
        );
      }

      // --- 9. ID-Konflikt-Check --------------------------------------------
      const existingUploaded = this.deps.store.get(plugin.id);
      const catalogEntry = this.deps.catalog.get(plugin.id);

      // #789 — a package claiming an id this image SHIPS is refused, and this
      // check is deliberately not conditioned on `existingUploaded`.
      //
      // The check below it is `catalogEntry && !existingUploaded`. That is
      // right for an ordinary collision (re-uploading your own plugin must
      // keep working) but wrong for a bundled id, because it opens once and
      // stays open: an id can be uploaded while it is not yet bundled and
      // become bundled in a later release, and from then on `existingUploaded`
      // is truthy and every subsequent zip for that id sails past. The catalog
      // erodes the same way — once an upload wins the collision the entry
      // under that key reads `origin: 'installed'`, so an origin test against
      // `catalogEntry` would be asking the shadow about the thing it hides.
      // `isBundledId` is asked instead: it records what the loader was OFFERED
      // as bundled, before the collision resolved.
      //
      // What is protected is not the id but what the id inherits.
      // `LEGACY_UNDECLARED_SERVICE_GRANTS_2026_08_20` is keyed by plugin id,
      // and `@omadia/orchestrator`'s row alone still carries more than a dozen
      // capabilities (nineteen at the 2026-08-20 audit, drained since),
      // `graphPool` and `tigrisStore` among them. The grant gate already
      // refuses those to a shadowing package (`legacyServiceGrantsFor`); this
      // is the second lock — on the door rather than on the safe.
      if (this.deps.catalog.isBundledId(plugin.id) && !allowBundledIdOverride()) {
        return fail(
          'package.id_conflict_bundled',
          `Plugin-ID "${plugin.id}" gehört zu einem mitgelieferten (bundled) Plugin dieser Installation. ` +
            'Ein Upload darf ein mitgeliefertes Plugin nicht überschreiben — vergib dem Paket eine eigene ID. ' +
            `Wenn der Override bewusst gewollt ist, setze ${BUNDLED_ID_OVERRIDE_ENV}=1 in der Middleware-Umgebung.`,
          { pluginId: plugin.id, overrideEnv: BUNDLED_ID_OVERRIDE_ENV },
          { pluginId: plugin.id, overrideEnv: BUNDLED_ID_OVERRIDE_ENV },
        );
      }

      if (catalogEntry && !existingUploaded) {
        return fail(
          'package.id_conflict_builtin',
          `Plugin-ID "${plugin.id}" kollidiert mit einem Built-in-Eintrag im Katalog.`,
          undefined,
          { pluginId: plugin.id },
        );
      }
      if (existingUploaded && existingUploaded.version === plugin.version) {
        return fail(
          'package.duplicate_version',
          `Version ${plugin.version} von ${plugin.id} ist bereits hochgeladen. Version anheben oder DELETE aufrufen.`,
          undefined,
          { pluginId: plugin.id, version: plugin.version },
        );
      }

      // --- 9a. Version direction (#1455) -----------------------------------
      // The equality check above used to be the ONLY version check in this
      // pipeline, which made "newer" and "older" the same code path: the
      // migration below ran, `onPackageReady` swapped the running instance,
      // and the replaced package folder was deleted — with nothing in the
      // response or the log naming a direction. An older version arriving for
      // a plugin that is already installed is an operator slip far more often
      // than an intent (a stale `?version=` on the Hub route, a stale zip), so
      // it has to be asked for rather than assumed.
      //
      // The comparison is against the STORE entry, not against the installed
      // registry: the store holds one version per plugin, and that is the
      // package this ingest is about to replace and delete — whether or not a
      // runtime instance happens to be running on it.
      const direction: VersionChangeDirection | null = existingUploaded
        ? versionDirection(existingUploaded.version, plugin.version)
        : null;
      if (
        existingUploaded &&
        direction === 'downgrade' &&
        input.allowDowngrade !== true
      ) {
        return fail(
          'package.downgrade_blocked',
          `Version ${plugin.version} von ${plugin.id} ist älter als die installierte Version ${existingUploaded.version}. ` +
            'Ein Downgrade tauscht die laufende Instanz aus — es muss ausdrücklich bestätigt werden ' +
            '(allow_downgrade).',
          undefined,
          {
            pluginId: plugin.id,
            fromVersion: existingUploaded.version,
            toVersion: plugin.version,
          },
        );
      }

      // --- 9b. Migration-Hook (onMigrate) ----------------------------------
      // Runs on a version CHANGE of an agent already installed in the
      // registry. Fresh uploads (no registry entry) or re-uploads of the same
      // version (caught above) do not trigger migration. The hook runs BEFORE
      // the packages are swapped — if it throws, v1 stays unchanged and the
      // upload is rejected.
      //
      // #1455 — a change, not strictly an upgrade: a confirmed downgrade runs
      // the hook too, with `fromVersion` above `toVersion`. The direction is
      // in the log line the runner writes, and a plugin that needs to tell the
      // two apart can compare the versions its `onMigrate` is handed.
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
        // No runner injected (e.g. bare-bones setup) → handle like opt-in
        // without hook: carry old config over unchanged, bump version.
        migratedConfig = installedBefore.config;
      }

      // --- 10. Atomic rename into the final directory ----------------------
      // Containment is re-asserted here, independently of the charset gate in
      // the manifest loader: the next two statements are an `fs.rm -rf` and a
      // rename, so this is the last place where a traversing id/version can
      // still be stopped, and it must not depend on a single upstream check
      // staying correct.
      const contained = resolveContainedPackageDir(
        this.deps.packagesDir,
        plugin.id,
        plugin.version,
      );
      if (!contained.ok) {
        return fail('package.path_traversal', contained.message);
      }
      const finalDir = contained.dir;
      await fs.mkdir(path.dirname(finalDir), { recursive: true });
      // If leftovers from an aborted installation are lying around → remove.
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(packageRoot, finalDir);

      // If the zip had a wrapper folder, stagingRoot is now empty
      // (packageRoot was a child). Clean up.
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

      // #1455 — retire the replaced version instead of deleting it here. This
      // used to be an `fs.rm`, several steps BEFORE `onPackageReady` activates
      // the new version, so a swap whose activation failed left the operator
      // with no package to go back to (the swallowed activation error itself
      // is #1452). The copy is removed once activation has succeeded, so this
      // is not the side-by-side layout the old comment ruled out: the store
      // index still points at exactly one version per plugin, and the catalog
      // is built from that index rather than from a directory scan.
      let retired: { dir: string; version: string } | null = null;
      if (existingUploaded && existingUploaded.path !== finalDir) {
        const dir = await retirePackageDir(existingUploaded, log);
        if (dir !== null) retired = { dir, version: existingUploaded.version };
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

      // #1455 — the direction tag is independent of `[migrated]`: a downgrade
      // onto a package that is uploaded but not installed runs no migration
      // and would otherwise leave no trace in the log at all.
      log(
        `[upload] ingest OK id=${plugin.id} version=${plugin.version} sha256=${sha256.slice(0, 12)} peers_missing=${peersMissing.length}${direction === 'downgrade' ? ' [downgrade]' : ''}${migratedConfig !== null ? ' [migrated]' : ''}`,
      );

      // Advisory code scan (issue #453) — fire-and-forget AFTER the package
      // is fully ingested. Not awaited: ingest latency stays unaffected, and
      // any scheduler error is contained here.
      if (this.deps.scanScheduler) {
        try {
          void this.deps.scanScheduler
            .scheduleScan({
              sha256,
              pluginId: plugin.id,
              installedDir: finalDir,
            })
            .catch((err: unknown) => {
              log(
                `[upload] plugin scan for ${plugin.id} failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        } catch (err) {
          log(
            `[upload] plugin scan scheduling for ${plugin.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Re-upload onto an already installed agent (typical: package file
      // was deleted, registry entry still `active`). Without the hook the
      // agent stays "installed but inactive" — the tool would be visible
      // neither in Harness nor in Teams. The hook does not break the upload
      // response — the package IS ingested, and an activation failure is a
      // separate fact — but #1452: NOT RE-THROWING IS NOT THE SAME AS NOT
      // RECORDING. Swallowing the throw here left the registry entry claiming
      // `active` with `last_activation_error: null` over a plugin whose
      // `undo()` had rolled everything back, so the store badge kept showing
      // the last SUCCESSFUL activation and readiness kept answering `ready`.
      // Same bug the install path had in #799 / #825, on the path an operator
      // uses far more often: the update button.
      let activationError: string | undefined;
      const reactivated =
        this.deps.onPackageReady !== undefined && this.shouldReactivate(plugin.id);
      if (reactivated && this.deps.onPackageReady) {
        try {
          await this.deps.onPackageReady(plugin.id);
          await this.noteActivationSuccess(plugin.id);
        } catch (err) {
          // A message, always. `new Error()` leaves `err.message` empty, and
          // every consumer of this value tests truthiness (`if
          // (res.activation_error)` in the store, `error_detail` in
          // `computeReadiness`, `last_activation_error` in the registry), so an
          // empty string would flip the entry to `errored` with the reason
          // readable nowhere — this fix's own failure mode.
          const failure = describeActivationFailure(
            err,
            'onPackageReady threw without a message',
          );
          activationError = failure.message;
          log(
            `[upload] onPackageReady hook failed for ${plugin.id}: ${activationError}`,
          );
          await this.noteActivationFailure(plugin.id, failure);
        }
      }
      // #1497 — the shared activation-result shape, only when this ingest
      // actually (re)activated the plugin, read back from the registry so it
      // agrees with `GET /runtime/installed`. No registry, no recorded truth.
      const activation =
        reactivated && this.deps.registry
          ? (activationResultOf(this.deps.registry.get(plugin.id)) ?? undefined)
          : undefined;

      // #1455 — the retired copy has served its purpose once the new version
      // is up. It is kept on a failed activation, and its path is logged
      // because it is the way back: that folder holds the complete previous
      // package, so zipping it and uploading it again restores what was
      // running — with `allow_downgrade`, since going back is itself a
      // downgrade.
      if (retired !== null) {
        if (activationError !== undefined) {
          log(
            `[upload] ${plugin.id}: new version did not activate — previous version ${retired.version} kept at ${retired.dir} (re-upload that folder with allow_downgrade to go back)`,
          );
        } else {
          await fs.rm(retired.dir, { recursive: true, force: true }).catch(() => {});
        }
      }

      return {
        ok: true,
        package: pkgRecord,
        plugin_id: plugin.id,
        version: plugin.version,
        ...(direction !== null ? { direction } : {}),
        ...(activationError !== undefined
          ? { activation_error: activationError }
          : {}),
        ...(activation !== undefined ? { activation } : {}),
      };
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * #1452 — does this ingest land on a plugin the host is supposed to be
   * running? The gate lives here, next to the recording, rather than inside
   * the host's hook: a second gate in the hook would silently turn the
   * success recording below into a lie for every entry the hook declines to
   * touch. Without a registry there is nothing to gate on (bare setups,
   * tests) — the hook runs as before and nothing is recorded.
   *
   *   * `active`   → the update / re-upload case this hook exists for.
   *   * `errored` below the circuit-breaker threshold → a previous activation
   *                  failed. Reactivating is the ONLY way an operator can
   *                  recover by installing a fixed version; skipping it would
   *                  make the `errored` state this change introduces a dead
   *                  end, because `retryErroredPlugins`' mtime path cannot
   *                  help here (`last_activation_error_at` is stamped after
   *                  the package rename, so the manifest is never newer).
   *   * `errored` at or above the threshold → left alone. The count is the
   *                  only thing separating two states that share the
   *                  `errored` word: a plugin the breaker latched after
   *                  `CIRCUIT_BREAKER_THRESHOLD` boot failures, and an OM-87
   *                  `markActivationBlocked` (non-retryable by definition,
   *                  floors the count at the threshold without counting an
   *                  attempt). Neither may be walked around by an upload —
   *                  `bootstrap.retryErroredPlugins` lifts them on evidence.
   *   * `inactive` → deliberately stood down (e.g. the embedding-provider
   *                  swap in adminEmbeddingProvider.ts). An upload must not
   *                  start it again.
   *   * absent     → not installed; the install flow activates and reports.
   */
  private shouldReactivate(pluginId: string): boolean {
    const registry = this.deps.registry;
    if (!registry) return true;
    const entry = registry.get(pluginId);
    if (!entry) return false;
    if (entry.status === 'active') return true;
    if (entry.status !== 'errored') return false;
    return (entry.activation_failure_count ?? 0) < CIRCUIT_BREAKER_THRESHOLD;
  }

  /**
   * #1452 — the hook returned, so the plugin is running. Lift the
   * circuit-breaker state first, then stamp the activation: a plugin that
   * comes back up after the operator installed a fixed version must stop
   * reading `errored`, or the update would appear not to have worked.
   *
   * Same pair, in the same order, as `InstallService.reactivate`'s success
   * path. The tool and agent runtimes already stamp
   * `markActivationSucceeded` themselves, so for those this is the lift;
   * channels record nothing of their own (`channelRegistry` never writes to
   * the registry), so for those it is both.
   */
  private async noteActivationSuccess(pluginId: string): Promise<void> {
    const registry = this.deps.registry;
    if (!registry) return;
    try {
      await recordActivationSuccess(registry, pluginId);
    } catch (err) {
      this.log(
        `[upload] registry markActivationSucceeded FAILED for ${pluginId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * #1452 — write down that the post-ingest (re)activation did not take.
   *
   * Two writes, because they answer different questions — the same pair
   * `InstallService.completeInstall` makes for the install path.
   * `markActivationFailed` records WHY and feeds
   * `bootstrap.retryErroredPlugins`; it does not flip the status on its own,
   * because `CIRCUIT_BREAKER_THRESHOLD` is 3. That threshold is right for a
   * boot loop retrying a transient failure and wrong here: an update the
   * operator just clicked is a single definitive event they are watching, not
   * the first of three strikes. So the status is set explicitly, and only when
   * the entry still reads `active` (the threshold may already have done it).
   *
   * The registry writes are themselves contained: a failing registry must not
   * turn a successful ingest into an HTTP error, and the hook's verdict still
   * travels back to the caller in `activation_error`.
   */
  private async noteActivationFailure(
    pluginId: string,
    failure: ActivationFailure,
  ): Promise<void> {
    const registry = this.deps.registry;
    if (!registry) return;
    try {
      await recordActivationFailure(registry, pluginId, failure);
    } catch (err) {
      this.log(
        `[upload] registry markActivationFailed FAILED for ${pluginId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The file's logger, not `deps.log?.()` — a setup without the dep must
   *  still put a failed registry write on stdout, or the reason this change
   *  exists to record is readable nowhere. Mirrors `ingest`'s own fallback. */
  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(msg);
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

/**
 * Entries that live DIRECTLY under the packages root and are not plugin
 * directories: the host-node_modules symlink written by
 * {@link ensureHostNodeModulesLink} and the store index. A plugin id equal to
 * one of them stays inside the root as a string but would either follow the
 * symlink out of the packages tree (into the host's real `node_modules`) or
 * collide with the index file. `.staging` needs no entry — a leading dot is
 * already outside the id charset.
 */
const RESERVED_ROOT_ENTRIES: ReadonlySet<string> = new Set([
  'node_modules',
  'index.json',
]);

/**
 * Resolves `<packagesDir>/<id>/<version>` and proves it stays under the
 * packages root. Defence in depth for the manifest loader's charset gate: the
 * caller is about to `fs.rm -rf` this path, so containment is verified here
 * from the raw values rather than assumed. Exported so the escape branch can
 * be exercised directly — through `ingest` the loader's charset gate rejects
 * a traversing id first, which is the point of having two layers.
 */
export function resolveContainedPackageDir(
  packagesDir: string,
  pluginId: string,
  version: string,
): { ok: true; dir: string } | { ok: false; message: string } {
  const root = path.resolve(packagesDir);
  const dir = path.resolve(path.join(root, pluginId, version));
  if (!dir.startsWith(root + path.sep)) {
    return {
      ok: false,
      message: `manifest.identity id/version resolve outside the packages directory (id=${JSON.stringify(pluginId)}, version=${JSON.stringify(version)}).`,
    };
  }
  const firstSegment = path.relative(root, dir).split(path.sep)[0];
  if (firstSegment !== undefined && RESERVED_ROOT_ENTRIES.has(firstSegment)) {
    return {
      ok: false,
      message: `manifest.identity.id ${JSON.stringify(pluginId)} collides with the reserved packages-root entry '${firstSegment}'.`,
    };
  }
  return { ok: true, dir };
}

async function resolvePackageRoot(stagingRoot: string): Promise<string | null> {
  if (await fileExists(path.join(stagingRoot, 'manifest.yaml'))) {
    return stagingRoot;
  }
  const level1 = await readSubdirs(stagingRoot);
  // Single-wrapper case is the npm-pack norm. We also tolerate one extra
  // level so a hand-uploaded ZIP built by a producer that did not sanitize
  // a scoped package name (`@scope/<wrapper>/manifest.yaml`) still ingests
  // — at this depth there is no plausible legitimate alternative layout.
  if (level1.length === 1) {
    const sub = level1[0];
    if (!sub) return null;
    const candidate = path.join(stagingRoot, sub.name);
    if (await fileExists(path.join(candidate, 'manifest.yaml'))) {
      return candidate;
    }
    const level2 = await readSubdirs(candidate);
    if (level2.length === 1) {
      const sub2 = level2[0];
      if (!sub2) return null;
      const nested = path.join(candidate, sub2.name);
      if (await fileExists(path.join(nested, 'manifest.yaml'))) {
        return nested;
      }
    }
  }
  return null;
}

/**
 * Reads every `.js` / `.mjs` below the staged package's `ui/` directory for
 * the arbitrary-value scan. Bounded on purpose: a bundle past the cap is left
 * unscanned rather than allowed to turn ingest into an OOM. `node_modules`
 * and dot-directories are skipped — the served bundle never reaches into them
 * (`pluginUiStatic.ts` serves the `ui/` tree only, and the extractor rejects
 * symlinks outright).
 */
const UI_SCAN_MAX_FILES = 200;
const UI_SCAN_MAX_BYTES = 8 * 1024 * 1024;

async function readUiBundleScripts(
  packageRoot: string,
): Promise<Array<{ path: string; content: string }>> {
  const uiRoot = path.join(packageRoot, 'ui');
  const out: Array<{ path: string; content: string }> = [];
  let budget = UI_SCAN_MAX_BYTES;

  const walk = async (dir: string): Promise<void> => {
    if (out.length >= UI_SCAN_MAX_FILES || budget <= 0) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= UI_SCAN_MAX_FILES || budget <= 0) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== '.js' && ext !== '.mjs') continue;
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf-8');
      } catch {
        continue;
      }
      budget -= Buffer.byteLength(content);
      out.push({
        path: path.relative(packageRoot, abs).split(path.sep).join('/'),
        content,
      });
    }
  };

  await walk(uiRoot);
  return out;
}

async function readSubdirs(dir: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory());
  } catch {
    return [];
  }
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

function fail(
  code: string,
  message: string,
  details?: unknown,
  params?: Record<string, string>,
): IngestFailure {
  const out: IngestFailure = { ok: false, code, message };
  if (details !== undefined) out.details = details;
  if (params !== undefined) out.params = params;
  return out;
}
