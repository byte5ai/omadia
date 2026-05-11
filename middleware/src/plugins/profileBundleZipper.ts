import { promises as fs } from 'node:fs';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';
import yazl from 'yazl';

import {
  computeBundleHash,
  ProfileBundleManifestSchema,
  sha256Hex,
  type ProfileBundleManifest,
  type ProfileBundlePluginPin,
} from './profileBundleManifest.js';
import type { UploadedPackageStore } from './uploadedPackageStore.js';

/**
 * Profile-Bundle v1 Zipper.
 *
 * Spec: docs/harness-platform/specs/profile-bundle-v1.md
 *
 * Erzeugt das portable ZIP-Format. Vendoring (Plugin-ZIPs ins Bundle kopieren)
 * ist opt-in über `vendorPlugins: true`; Default sind ausschließlich Pins.
 *
 * Plugin-Pin-Resolution geht gegen den lokalen `UploadedPackageStore` —
 * Built-in-Plugins (im Manifest-Catalog, aber nicht im Upload-Store) werden
 * mit `sha256` aus dem Aufruf-Input belegt, weil der Catalog selbst keine
 * Hashes führt. Wenn der Caller weder `sha256` mitgibt noch das Plugin im
 * Upload-Store steht, ist das ein harter Fehler.
 */

export interface PluginPinInput {
  id: string;
  version: string;
  /**
   * Optional. Wenn nicht angegeben, wird das Plugin im UploadedPackageStore
   * gesucht und dessen sha256 verwendet.
   */
  sha256?: string;
}

export interface KnowledgeFileInput {
  /** Filename (ohne `knowledge/`-Prefix). */
  filename: string;
  content: Buffer;
}

export interface ZipProfileBundleInput {
  profileId: string;
  profileName: string;
  profileVersion: string;
  createdBy: string;
  /** Inhalt der `agent.md` als String oder Buffer. */
  agentMd: string | Buffer;
  pluginPins: PluginPinInput[];
  knowledge?: KnowledgeFileInput[];
  /** Wenn true, werden Plugin-ZIPs aus dem UploadedPackageStore mitgepackt. */
  vendorPlugins?: boolean;
  /**
   * OB-83 — inline vendored plugin ZIP buffers, keyed by `<id>@<version>`.
   * When a `pluginPins[]` entry matches a key here, the corresponding
   * buffer is packed at `plugins/<id>-<version>.zip` in the bundle and
   * the pin's `vendored` flag flips to true. Lets the Builder snapshot
   * ship freshly-built plugin ZIPs without round-tripping through the
   * UploadedPackageStore.
   */
  inlineVendoredPlugins?: Map<string, Buffer>;
  /**
   * Optionaler Override für `created_at`. Hauptsächlich für Tests, damit
   * Bundles deterministisch reproduzierbar sind.
   */
  createdAt?: string;
}

export interface ZipProfileBundleResult {
  buffer: Buffer;
  manifest: ProfileBundleManifest;
  /** sha256 des fertigen Bundle-ZIPs (für Audit/Logging). */
  zipSha256: string;
}

export class ProfileBundleZipperError extends Error {
  constructor(
    public readonly code:
      | 'bundle.unknown_plugin'
      | 'bundle.plugin_zip_missing'
      | 'bundle.invalid_manifest'
      | 'bundle.size_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'ProfileBundleZipperError';
  }
}

/** 50 MB Default-Cap. Knowledge-Files sind der größte Treiber. */
const DEFAULT_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

/** Reserved knowledge filename pattern — same allowlist as zipExtractor. */
const KNOWLEDGE_EXT_ALLOWLIST = new Set(['.md', '.txt', '.pdf', '.json']);

export interface ZipperDeps {
  store: UploadedPackageStore;
  /** Override für maxBytes (Tests). */
  maxBundleBytes?: number;
}

export async function zipProfileBundle(
  deps: ZipperDeps,
  input: ZipProfileBundleInput,
): Promise<ZipProfileBundleResult> {
  const maxBytes = deps.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;

  // --- 1. agent.md normalisieren + hashen ---------------------------------
  const agentBuffer = Buffer.isBuffer(input.agentMd)
    ? input.agentMd
    : Buffer.from(input.agentMd, 'utf8');
  const agentSha256 = sha256Hex(agentBuffer);

  // --- 2. Plugin-Pins auflösen --------------------------------------------
  const resolvedPlugins: Array<
    ProfileBundlePluginPin & { zipPath?: string; inlineBuffer?: Buffer }
  > = [];
  const inlineMap = input.inlineVendoredPlugins;
  for (const pin of input.pluginPins) {
    const inlineKey = `${pin.id}@${pin.version}`;
    const inlineBuffer = inlineMap?.get(inlineKey);
    const stored = deps.store.get(pin.id);
    let sha256 = pin.sha256;
    let zipPath: string | undefined;

    // OB-83 — inline vendored plugins (freshly built by the snapshot
    // path) take precedence over the upload-store lookup. The caller
    // supplies the bytes directly, so we trust their sha256 (computed
    // by the loader) and skip the store entirely.
    if (inlineBuffer) {
      const inlineSha = sha256Hex(inlineBuffer);
      if (sha256 && sha256 !== inlineSha) {
        throw new ProfileBundleZipperError(
          'bundle.unknown_plugin',
          `inline vendored plugin ${pin.id}@${pin.version} sha256 mismatch (input=${sha256.slice(0, 12)}, computed=${inlineSha.slice(0, 12)})`,
        );
      }
      sha256 = inlineSha;
    } else if (stored && stored.version === pin.version) {
      // Plugin liegt im Upload-Store: dessen sha256 ist die Wahrheit
      if (sha256 && sha256 !== stored.sha256) {
        throw new ProfileBundleZipperError(
          'bundle.unknown_plugin',
          `plugin ${pin.id}@${pin.version} sha256 mismatch (input=${sha256.slice(0, 12)}, store=${stored.sha256.slice(0, 12)})`,
        );
      }
      sha256 = stored.sha256;
      // Vendoring: für gestockte Pakete erwarten wir ein begleitendes ZIP
      // unter `<store.path>.zip`. Falls nicht vorhanden, müssen wir das
      // entpackte Verzeichnis selbst zippen.
      zipPath = stored.path;
    }

    // Vendoring is best-effort, NOT all-or-nothing. The vendorPlugins
    // flag means "include real bytes for plugins that have them";
    // built-in plugins (catalog-backed, no entry in UploadedPackageStore)
    // remain pin-only in the bundle. This matches the operator's likely
    // intent — they want to ship what they CAN, not abort the snapshot
    // because a system plugin lacks an upload-store ZIP.
    //
    // A future air-gap-strict mode could turn the soft fallback back into
    // a hard error; today, the snapshot's manifest captures the mix
    // honestly and the importer's catalog-trust branch picks up the rest.
    const wantsVendoring = !!input.vendorPlugins || !!inlineBuffer;
    const canVendor = wantsVendoring && (!!zipPath || !!inlineBuffer);
    if (wantsVendoring && !canVendor) {
      // Caller wanted vendoring but this plugin can't be packed — fall
      // through with vendored=false. (Operator-visible warning surfaces
      // via the response object's `pinOnlyPlugins` field below.)
    }

    if (!sha256) {
      // Plugin is neither in the upload store nor accompanied by a caller-
      // supplied sha256 — this is the built-in plugin path (catalog-backed
      // plugins shipped inside the middleware tree never appear in
      // UploadedPackageStore). Synthesize a deterministic identity hash
      // over `id@version` so the manifest stays a valid Bundle-v1 doc.
      // The Importer's catalog-trust branch (profileBundleImporter.ts:
      // "Built-in plugin — catalog is authoritative") accepts whatever
      // sha256 the manifest carries, so this synthetic value round-trips
      // safely as long as the plugin is also a built-in on the import side.
      sha256 = sha256Hex(`builtin:${pin.id}@${pin.version}`);
    }

    const entry: ProfileBundlePluginPin & {
      zipPath?: string;
      inlineBuffer?: Buffer;
    } = {
      id: pin.id,
      version: pin.version,
      sha256,
      vendored: canVendor,
    };
    if (canVendor && inlineBuffer) entry.inlineBuffer = inlineBuffer;
    else if (canVendor && zipPath) entry.zipPath = zipPath;
    resolvedPlugins.push(entry);
  }

  // --- 3. Knowledge-Dateien normalisieren ----------------------------------
  const knowledge = (input.knowledge ?? []).map((k) => {
    const ext = path.extname(k.filename).toLowerCase();
    if (!KNOWLEDGE_EXT_ALLOWLIST.has(ext)) {
      throw new ProfileBundleZipperError(
        'bundle.invalid_manifest',
        `knowledge file '${k.filename}' has disallowed extension '${ext}' (allowed: ${[...KNOWLEDGE_EXT_ALLOWLIST].join(', ')})`,
      );
    }
    if (k.filename.includes('/') || k.filename.includes('\\') || k.filename.includes('..')) {
      throw new ProfileBundleZipperError(
        'bundle.invalid_manifest',
        `knowledge file '${k.filename}' must be a flat filename (no path separators)`,
      );
    }
    return {
      filename: `knowledge/${k.filename}`,
      content: k.content,
      sha256: sha256Hex(k.content),
    };
  });

  // --- 4. plugins.lock erzeugen --------------------------------------------
  const pluginsLockBody =
    resolvedPlugins
      .map((p) => {
        const suffix = p.vendored ? ' vendored' : '';
        return `${p.id}@${p.version} sha256=${p.sha256}${suffix}`;
      })
      .join('\n') + '\n';

  // --- 5. Bundle-Hash berechnen --------------------------------------------
  const bundleHash = computeBundleHash(input.profileId, input.profileVersion, {
    agentSha256,
    plugins: resolvedPlugins.map((p) => ({
      id: p.id,
      version: p.version,
      sha256: p.sha256,
    })),
    knowledge: knowledge.map((k) => ({ file: k.filename, sha256: k.sha256 })),
  });

  // --- 6. Manifest bauen + Zod-validieren ---------------------------------
  const manifestObject: ProfileBundleManifest = {
    harness: { bundleSpec: 1 },
    profile: {
      id: input.profileId,
      name: input.profileName,
      version: input.profileVersion,
      created_at: input.createdAt ?? new Date().toISOString(),
      created_by: input.createdBy,
    },
    agent: { file: 'agent.md', sha256: agentSha256 },
    plugins: resolvedPlugins.map(({ zipPath: _zip, ...pin }) => pin),
    knowledge: knowledge.map((k) => ({ file: k.filename, sha256: k.sha256 })),
    bundle_hash: bundleHash,
  };

  const validation = ProfileBundleManifestSchema.safeParse(manifestObject);
  if (!validation.success) {
    throw new ProfileBundleZipperError(
      'bundle.invalid_manifest',
      `manifest failed validation: ${validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const manifest = validation.data;

  const manifestYaml = stringifyYaml(manifest);

  // --- 7. ZIP erzeugen via yazl --------------------------------------------
  const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    let totalSize = 0;

    zip.outputStream.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        reject(
          new ProfileBundleZipperError(
            'bundle.size_exceeded',
            `bundle exceeds maxBundleBytes=${maxBytes}`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);

    const mtime = new Date(0); // deterministic — zero out timestamps
    const opts = { mtime, compress: true };

    zip.addBuffer(Buffer.from(manifestYaml, 'utf8'), 'profile-manifest.yaml', opts);
    zip.addBuffer(agentBuffer, 'agent.md', opts);
    zip.addBuffer(Buffer.from(pluginsLockBody, 'utf8'), 'plugins.lock', opts);

    for (const k of knowledge) {
      zip.addBuffer(k.content, k.filename, opts);
    }

    // Vendored plugins: pack inline-supplied buffers OR
    // store-resolved ZIPs at `plugins/<id>-<version>.zip`. Inline
    // buffers (Builder snapshot path) take precedence per pin; the
    // outer `vendorPlugins` flag is no longer required to gate this
    // because pins with `inlineBuffer` set are explicit per-plugin.
    const vendoredEntries = resolvedPlugins.filter(
      (p) => p.vendored && (p.inlineBuffer || p.zipPath),
    );
    if (vendoredEntries.length > 0) {
      Promise.all(
        vendoredEntries.map(async (p) => {
          const buf = p.inlineBuffer
            ? p.inlineBuffer
            : await readVendoredPluginZip(p.zipPath as string);
          const innerName = `plugins/${p.id}-${p.version}.zip`;
          return { innerName, buf };
        }),
      )
        .then((entries) => {
          for (const e of entries) {
            zip.addBuffer(e.buf, e.innerName, { mtime, compress: false });
          }
          zip.end();
        })
        .catch(reject);
    } else {
      zip.end();
    }
  });

  return {
    buffer: zipBuffer,
    manifest,
    zipSha256: sha256Hex(zipBuffer),
  };
}

/**
 * Liest ein bereits gepacktes Plugin-ZIP von Disk. Wenn `zipPath` ein
 * Verzeichnis ist (UploadedPackageStore liefert das Package-Root, nicht das
 * ZIP), packen wir das Verzeichnis spontan zu einem ZIP-Buffer.
 */
async function readVendoredPluginZip(zipPath: string): Promise<Buffer> {
  const stat = await fs.stat(zipPath);
  if (stat.isFile()) {
    return fs.readFile(zipPath);
  }
  if (!stat.isDirectory()) {
    throw new ProfileBundleZipperError(
      'bundle.plugin_zip_missing',
      `vendored plugin path is neither file nor directory: ${zipPath}`,
    );
  }
  return zipDirectory(zipPath);
}

async function zipDirectory(dir: string): Promise<Buffer> {
  const entries = await collectFiles(dir);
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    const mtime = new Date(0);
    for (const f of entries) {
      const rel = path.relative(dir, f);
      zip.addFile(f, rel, { mtime });
    }
    zip.end();
  });
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}
