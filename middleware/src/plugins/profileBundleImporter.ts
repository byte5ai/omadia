import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { PluginCatalog } from './manifestLoader.js';
import type { PackageUploadService } from './packageUploadService.js';
import {
  computeBundleHash,
  ProfileBundleManifestSchema,
  sha256Hex,
  type ProfileBundleManifest,
  type ProfileBundlePluginPin,
} from './profileBundleManifest.js';
import type { UploadedPackageStore } from './uploadedPackageStore.js';
import { extractZipToDir, ZipExtractionError } from './zipExtractor.js';

/**
 * Profile-Bundle v1 Importer.
 *
 * Spec: docs/harness-platform/specs/profile-bundle-v1.md
 *
 * Validation pipeline (each step is a hard reject):
 *   1. Extract ZIP into staging dir (Zip-Slip-/Bomb-Schutz via extractZipToDir)
 *   2. Verify allowed top-level layout
 *   3. Parse + Zod-validate profile-manifest.yaml
 *   4. Verify harness.bundleSpec === 1
 *   5. Verify agent.md sha256
 *   6. Verify each knowledge sha256
 *   7. Recompute bundle_hash and compare
 *   8. Plugin-Whitelist:
 *      - vendored=false → must be in catalog OR upload-store with matching sha256
 *      - vendored=true  → install plugin-zip via PackageUploadService.ingest()
 *
 * Side effects (all happen AFTER validation passes):
 *   - vendored plugins go through PackageUploadService.ingest()
 *   - profile artifacts (agent.md, knowledge/) are persisted via the
 *     `onPersist` callback (Profile-Storage is owned by the API layer; the
 *     Importer stays storage-agnostic).
 */

export interface ImportProfileBundleInput {
  fileBuffer: Buffer;
  uploadedBy: string;
  /**
   * Hook to persist the profile artifacts (agent.md, knowledge/, manifest).
   * The importer hands over RAW bytes after validation; it does not write
   * to a profile store itself — that decision lives one layer up.
   */
  onPersist: (payload: PersistedBundlePayload) => Promise<void>;
}

export interface PersistedBundlePayload {
  manifest: ProfileBundleManifest;
  agentMd: Buffer;
  knowledge: Array<{ filename: string; content: Buffer }>;
  /**
   * Plugin pins after import. For vendored plugins this includes the result
   * of the {@link PackageUploadService.ingest} call so the caller can wire
   * them into the Profile state.
   */
  plugins: Array<{
    id: string;
    version: string;
    sha256: string;
    vendored: boolean;
    /** True if the plugin was newly installed during this import. */
    installed: boolean;
  }>;
}

export interface ImportSuccess {
  ok: true;
  profileId: string;
  profileVersion: string;
  bundleHash: string;
  pluginsInstalled: number;
}

export interface ImportFailure {
  ok: false;
  code: ImportErrorCode;
  message: string;
  details?: unknown;
}

export type ImportResult = ImportSuccess | ImportFailure;

export type ImportErrorCode =
  | 'bundle.invalid_zip'
  | 'bundle.too_large'
  | 'bundle.missing_manifest'
  | 'bundle.invalid_manifest'
  | 'bundle.missing_agent_md'
  | 'bundle.missing_plugins_lock'
  | 'bundle.unsupported_spec_version'
  | 'bundle.hash_mismatch'
  | 'bundle.agent_hash_mismatch'
  | 'bundle.knowledge_hash_mismatch'
  | 'bundle.unknown_plugin'
  | 'bundle.plugin_sha_mismatch'
  | 'bundle.vendored_plugin_missing'
  | 'bundle.vendored_install_failed'
  | 'bundle.foreign_top_level'
  | 'bundle.persist_failed';

export interface ImporterDeps {
  uploadedPackageStore: UploadedPackageStore;
  catalog: PluginCatalog;
  /** Required only when vendored plugins are present in the bundle. */
  uploadService?: PackageUploadService;
  /** Cap before extraction. Default 50 MB. */
  maxBytes?: number;
  /** Cap on extracted total. Default 500 MB. */
  maxExtractedBytes?: number;
  /** Cap on entry count. Default 2000. */
  maxEntries?: number;
  log?: (msg: string) => void;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_EXTRACTED = 500 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2000;

const ALLOWED_TOP_LEVEL = new Set([
  'profile-manifest.yaml',
  'agent.md',
  'plugins.lock',
]);
const ALLOWED_TOP_LEVEL_DIRS = new Set(['knowledge', 'plugins']);

/**
 * File extensions a Profile-Bundle is allowed to ship. Stricter than the
 * plugin-package allowlist — bundles are configuration, not code.
 *   - .yaml/.yml: manifest
 *   - .md/.txt/.json/.pdf: agent + knowledge
 *   - .zip: vendored plugin packages under plugins/
 */
const BUNDLE_EXT_ALLOWLIST: ReadonlySet<string> = new Set([
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.json',
  '.pdf',
  '.zip',
]);

/** Bare-basenames accepted alongside the extension allowlist. */
const BUNDLE_BASENAME_ALLOWLIST: ReadonlySet<string> = new Set(['plugins.lock']);

export class ProfileBundleImporter {
  constructor(private readonly deps: ImporterDeps) {}

  async import(input: ImportProfileBundleInput): Promise<ImportResult> {
    const log = this.deps.log ?? ((m) => console.log(m));
    const maxBytes = this.deps.maxBytes ?? DEFAULT_MAX_BYTES;

    if (input.fileBuffer.byteLength > maxBytes) {
      return fail(
        'bundle.too_large',
        `bundle exceeds ${maxBytes} bytes (got ${input.fileBuffer.byteLength})`,
      );
    }

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-bundle-'));
    const stagingDir = path.join(tmpRoot, 'staging');
    const zipPath = path.join(tmpRoot, 'bundle.zip');
    await fs.writeFile(zipPath, input.fileBuffer);

    try {
      // --- 1. Extract -------------------------------------------------------
      try {
        await extractZipToDir(zipPath, stagingDir, {
          maxEntries: this.deps.maxEntries ?? DEFAULT_MAX_ENTRIES,
          maxExtractedBytes: this.deps.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED,
          extensionAllowlist: BUNDLE_EXT_ALLOWLIST,
          basenameAllowlist: BUNDLE_BASENAME_ALLOWLIST,
        });
      } catch (err) {
        if (err instanceof ZipExtractionError) {
          return fail(
            err.code === 'zip.invalid' ? 'bundle.invalid_zip' : 'bundle.invalid_zip',
            err.message,
          );
        }
        throw err;
      }

      // --- 2. Top-level allowlist ------------------------------------------
      const topLevel = await fs.readdir(stagingDir, { withFileTypes: true });
      for (const e of topLevel) {
        if (e.isFile() && ALLOWED_TOP_LEVEL.has(e.name)) continue;
        if (e.isDirectory() && ALLOWED_TOP_LEVEL_DIRS.has(e.name)) continue;
        return fail(
          'bundle.foreign_top_level',
          `unexpected entry at bundle root: ${e.name}`,
        );
      }

      // --- 3. Required files exist -----------------------------------------
      const manifestPath = path.join(stagingDir, 'profile-manifest.yaml');
      const agentPath = path.join(stagingDir, 'agent.md');
      const lockPath = path.join(stagingDir, 'plugins.lock');

      if (!(await fileExists(manifestPath))) {
        return fail('bundle.missing_manifest', 'profile-manifest.yaml missing');
      }
      if (!(await fileExists(agentPath))) {
        return fail('bundle.missing_agent_md', 'agent.md missing');
      }
      if (!(await fileExists(lockPath))) {
        return fail('bundle.missing_plugins_lock', 'plugins.lock missing');
      }

      // --- 4. Manifest parse + validate ------------------------------------
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      let manifestDoc: unknown;
      try {
        manifestDoc = parseYaml(manifestRaw);
      } catch (err) {
        return fail(
          'bundle.invalid_manifest',
          `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const validation = ProfileBundleManifestSchema.safeParse(manifestDoc);
      if (!validation.success) {
        return fail(
          'bundle.invalid_manifest',
          `manifest schema validation failed: ${validation.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        );
      }
      const manifest = validation.data;

      // --- 5. Spec version --------------------------------------------------
      if (manifest.harness.bundleSpec !== 1) {
        return fail(
          'bundle.unsupported_spec_version',
          `unsupported bundleSpec ${String(manifest.harness.bundleSpec)} — this importer accepts spec=1 only`,
        );
      }

      // --- 6. agent.md sha256 ----------------------------------------------
      const agentBuffer = await fs.readFile(agentPath);
      const agentHash = sha256Hex(agentBuffer);
      if (agentHash !== manifest.agent.sha256) {
        return fail(
          'bundle.agent_hash_mismatch',
          `agent.md sha256 mismatch (manifest=${manifest.agent.sha256.slice(0, 12)}, computed=${agentHash.slice(0, 12)})`,
        );
      }

      // --- 7. Knowledge sha256 ----------------------------------------------
      const knowledgeBuffers = new Map<string, Buffer>();
      for (const k of manifest.knowledge) {
        const abs = path.join(stagingDir, k.file);
        if (!abs.startsWith(stagingDir + path.sep)) {
          return fail(
            'bundle.invalid_manifest',
            `knowledge entry escapes staging: ${k.file}`,
          );
        }
        if (!(await fileExists(abs))) {
          return fail(
            'bundle.invalid_manifest',
            `knowledge file referenced in manifest not found: ${k.file}`,
          );
        }
        const buf = await fs.readFile(abs);
        const hash = sha256Hex(buf);
        if (hash !== k.sha256) {
          return fail(
            'bundle.knowledge_hash_mismatch',
            `knowledge file ${k.file} sha256 mismatch (manifest=${k.sha256.slice(0, 12)}, computed=${hash.slice(0, 12)})`,
          );
        }
        knowledgeBuffers.set(k.file, buf);
      }

      // --- 8. Recompute bundle_hash ----------------------------------------
      const expectedBundleHash = computeBundleHash(
        manifest.profile.id,
        manifest.profile.version,
        {
          agentSha256: manifest.agent.sha256,
          plugins: manifest.plugins,
          knowledge: manifest.knowledge,
        },
      );
      if (expectedBundleHash !== manifest.bundle_hash) {
        return fail(
          'bundle.hash_mismatch',
          `bundle_hash mismatch (manifest=${manifest.bundle_hash.slice(0, 12)}, computed=${expectedBundleHash.slice(0, 12)}) — bundle was modified`,
        );
      }

      // --- 9. Plugin-Whitelist + Vendored-Install --------------------------
      const pluginResults: PersistedBundlePayload['plugins'] = [];
      for (const pin of manifest.plugins) {
        const result = await this.handlePluginPin(pin, stagingDir, input.uploadedBy);
        if (!result.ok) return result;
        pluginResults.push(result.persisted);
      }

      // --- 10. Persist (delegated) -----------------------------------------
      try {
        await input.onPersist({
          manifest,
          agentMd: agentBuffer,
          knowledge: manifest.knowledge.map((k) => {
            const buf = knowledgeBuffers.get(k.file);
            if (!buf) {
              throw new Error(`internal: knowledge buffer missing for ${k.file}`);
            }
            return { filename: k.file, content: buf };
          }),
          plugins: pluginResults,
        });
      } catch (err) {
        return fail(
          'bundle.persist_failed',
          `onPersist callback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      log(
        `[bundle-import] OK profile=${manifest.profile.id}@${manifest.profile.version} plugins=${pluginResults.length} (installed=${pluginResults.filter((p) => p.installed).length}) bundle_hash=${manifest.bundle_hash.slice(0, 12)}`,
      );

      return {
        ok: true,
        profileId: manifest.profile.id,
        profileVersion: manifest.profile.version,
        bundleHash: manifest.bundle_hash,
        pluginsInstalled: pluginResults.filter((p) => p.installed).length,
      };
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async handlePluginPin(
    pin: ProfileBundlePluginPin,
    stagingDir: string,
    uploadedBy: string,
  ): Promise<
    | { ok: true; persisted: PersistedBundlePayload['plugins'][number] }
    | ImportFailure
  > {
    if (pin.vendored) {
      const innerZipPath = path.join(stagingDir, 'plugins', `${pin.id}-${pin.version}.zip`);
      if (!innerZipPath.startsWith(stagingDir + path.sep)) {
        return fail('bundle.invalid_manifest', `plugin pin id escapes staging: ${pin.id}`);
      }
      if (!(await fileExists(innerZipPath))) {
        return fail(
          'bundle.vendored_plugin_missing',
          `vendored plugin ZIP not found at ${path.relative(stagingDir, innerZipPath)}`,
        );
      }
      const buf = await fs.readFile(innerZipPath);
      const hash = sha256Hex(buf);
      if (hash !== pin.sha256) {
        return fail(
          'bundle.plugin_sha_mismatch',
          `vendored plugin ${pin.id}@${pin.version} sha256 mismatch`,
        );
      }
      if (!this.deps.uploadService) {
        return fail(
          'bundle.vendored_install_failed',
          `vendored plugin ${pin.id} present but no PackageUploadService injected`,
        );
      }
      // Skip re-install if exact same version already in store with matching hash
      const existing = this.deps.uploadedPackageStore.get(pin.id);
      if (existing && existing.version === pin.version && existing.sha256 === pin.sha256) {
        return {
          ok: true,
          persisted: {
            id: pin.id,
            version: pin.version,
            sha256: pin.sha256,
            vendored: true,
            installed: false,
          },
        };
      }
      const ingestResult = await this.deps.uploadService.ingest({
        fileBuffer: buf,
        originalFilename: `${pin.id}-${pin.version}.zip`,
        uploadedBy,
        sha256: pin.sha256,
      });
      if (!ingestResult.ok) {
        return fail(
          'bundle.vendored_install_failed',
          `ingest failed for ${pin.id}@${pin.version}: ${ingestResult.code} — ${ingestResult.message}`,
        );
      }
      return {
        ok: true,
        persisted: {
          id: pin.id,
          version: pin.version,
          sha256: pin.sha256,
          vendored: true,
          installed: true,
        },
      };
    }

    // Non-vendored: must be in upload-store OR catalog with matching version
    const stored = this.deps.uploadedPackageStore.get(pin.id);
    if (stored && stored.version === pin.version) {
      if (stored.sha256 !== pin.sha256) {
        return fail(
          'bundle.plugin_sha_mismatch',
          `plugin ${pin.id}@${pin.version} sha256 differs from local copy (manifest=${pin.sha256.slice(0, 12)}, store=${stored.sha256.slice(0, 12)})`,
        );
      }
      return {
        ok: true,
        persisted: {
          id: pin.id,
          version: pin.version,
          sha256: pin.sha256,
          vendored: false,
          installed: false,
        },
      };
    }

    const catalogEntry = this.deps.catalog.get(pin.id);
    if (catalogEntry && catalogEntry.plugin.version === pin.version) {
      // Built-in plugin — catalog is authoritative; we trust the pin's sha256
      // because there is no canonical hash in the catalog itself.
      return {
        ok: true,
        persisted: {
          id: pin.id,
          version: pin.version,
          sha256: pin.sha256,
          vendored: false,
          installed: false,
        },
      };
    }

    return fail(
      'bundle.unknown_plugin',
      `plugin ${pin.id}@${pin.version} is not installed locally and not vendored — operator must install it before importing this bundle`,
    );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function fail(code: ImportErrorCode, message: string, details?: unknown): ImportFailure {
  const out: ImportFailure = { ok: false, code, message };
  if (details !== undefined) out.details = details;
  return out;
}
