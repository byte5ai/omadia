import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import yauzl from 'yauzl';

/**
 * Sicherer Zip-Extractor mit Guardrails.
 *
 * Schutz gegen:
 *   - Zip-Slip (Pfade außerhalb der Staging-Root)
 *   - Zip-Bombs (cumulative-uncompressed-bytes Cap + per-entry Cap)
 *   - Symlinks (rejected — yauzl liefert externalFileAttributes)
 *   - Zuviele Einträge (DoS-Schutz)
 *
 * Liefert eine Liste der entpackten Files (relative Pfade) zurück.
 */

const EXTENSION_ALLOWLIST: ReadonlySet<string> = new Set([
  '.yaml',
  '.yml',
  '.md',
  '.json',
  '.js',
  '.mjs',
  '.cjs',
  '.map',
  '.png',
  '.svg',
  '.jpg',
  '.jpeg',
  '.txt',
  '.license',
  // S+7.7 — Operator-Admin-UI bundle (assets/admin-ui/index.html). The
  // boilerplate ships an HTML template with marker regions that codegen
  // fills via the `admin-ui-body` slot; without `.html` here the upload
  // pipeline rejects the package as "disallowed extension".
  '.html',
]);

const DECL_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.mts', '.cts']);

export interface ExtractLimits {
  maxEntries: number;
  maxExtractedBytes: number;
  /** Per-File-Obergrenze, defensiv. Defaults sind vom Gesamtcap abgeleitet. */
  maxFileBytes?: number;
  /**
   * Optional override for the extension allowlist. When provided, the default
   * plugin-package allowlist is ignored entirely and only these extensions
   * (lower-case, including the dot) are accepted. The basename allowlist for
   * LICENSE/NOTICE/README/.npmignore is also dropped — caller must include
   * everything they want explicitly. Used by the Profile-Bundle importer to
   * accept `plugins.lock` while keeping all other security checks.
   */
  extensionAllowlist?: ReadonlySet<string>;
  /** Optional bare-basenames (e.g. ["plugins.lock"]) accepted alongside extensions. */
  basenameAllowlist?: ReadonlySet<string>;
}

export interface ExtractResult {
  files: string[];
  totalBytes: number;
}

export class ZipExtractionError extends Error {
  constructor(
    public readonly code:
      | 'zip.invalid'
      | 'zip.too_many_entries'
      | 'zip.path_escape'
      | 'zip.symlink'
      | 'zip.forbidden_extension'
      | 'zip.file_too_large'
      | 'zip.total_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'ZipExtractionError';
  }
}

export async function extractZipToDir(
  zipPath: string,
  destRoot: string,
  limits: ExtractLimits,
): Promise<ExtractResult> {
  const absDest = path.resolve(destRoot);
  await fs.mkdir(absDest, { recursive: true });

  const zipfile = await openZip(zipPath);
  const maxFileBytes = limits.maxFileBytes ?? limits.maxExtractedBytes;
  const entriesSeen: { type: 'dir' | 'file'; name: string }[] = [];
  const extracted: string[] = [];
  let totalBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.readEntry();

      zipfile.on('entry', (entry: yauzl.Entry) => {
        const done = (err?: Error): void => {
          if (err) reject(err);
          else zipfile.readEntry();
        };

        (async () => {
          if (entriesSeen.length >= limits.maxEntries) {
            throw new ZipExtractionError(
              'zip.too_many_entries',
              `zip contains more than ${limits.maxEntries} entries`,
            );
          }

          if (isSymlinkEntry(entry)) {
            throw new ZipExtractionError(
              'zip.symlink',
              `zip contains a symlink (${entry.fileName}) — not allowed`,
            );
          }

          const relativeName = entry.fileName.replace(/\\/g, '/');
          if (relativeName.startsWith('/') || relativeName.includes('..')) {
            throw new ZipExtractionError(
              'zip.path_escape',
              `zip contains an escaping path: ${entry.fileName}`,
            );
          }

          const absTarget = path.resolve(absDest, relativeName);
          if (!absTarget.startsWith(absDest + path.sep) && absTarget !== absDest) {
            throw new ZipExtractionError(
              'zip.path_escape',
              `resolved path escapes staging root: ${entry.fileName}`,
            );
          }

          if (isDirectoryEntry(entry)) {
            entriesSeen.push({ type: 'dir', name: relativeName });
            await fs.mkdir(absTarget, { recursive: true });
            return;
          }

          const ext = path.extname(relativeName).toLowerCase();
          const baseName = path.basename(relativeName);
          if (limits.extensionAllowlist) {
            const baseAllowed = limits.basenameAllowlist?.has(baseName) ?? false;
            if (!limits.extensionAllowlist.has(ext) && !baseAllowed) {
              throw new ZipExtractionError(
                'zip.forbidden_extension',
                `entry ${relativeName} has a disallowed extension (${ext || '<none>'})`,
              );
            }
          } else {
            const isTopLevelLike =
              baseName === 'LICENSE' ||
              baseName === 'NOTICE' ||
              baseName === 'README' ||
              baseName === '.npmignore';
            if (
              !EXTENSION_ALLOWLIST.has(ext) &&
              !DECL_EXTENSIONS.has(ext) &&
              !isTopLevelLike
            ) {
              throw new ZipExtractionError(
                'zip.forbidden_extension',
                `entry ${relativeName} has a disallowed extension (${ext || '<none>'})`,
              );
            }
          }

          if (entry.uncompressedSize > maxFileBytes) {
            throw new ZipExtractionError(
              'zip.file_too_large',
              `entry ${relativeName} exceeds per-file cap (${entry.uncompressedSize} > ${maxFileBytes})`,
            );
          }

          await fs.mkdir(path.dirname(absTarget), { recursive: true });

          const stream = await openReadStream(zipfile, entry);
          let written = 0;
          stream.on('data', (chunk: Buffer) => {
            written += chunk.length;
            if (written > entry.uncompressedSize + 1024) {
              stream.destroy(
                new ZipExtractionError(
                  'zip.file_too_large',
                  `stream of ${relativeName} exceeded declared size`,
                ),
              );
            }
            if (totalBytes + written > limits.maxExtractedBytes) {
              stream.destroy(
                new ZipExtractionError(
                  'zip.total_too_large',
                  `cumulative extracted size exceeds ${limits.maxExtractedBytes}`,
                ),
              );
            }
          });

          await pipeline(stream, createWriteStream(absTarget));
          totalBytes += written;
          entriesSeen.push({ type: 'file', name: relativeName });
          extracted.push(relativeName);
        })().then(() => done(), done);
      });

      zipfile.on('end', () => resolve());
      zipfile.on('error', (err) => reject(err));
    });
  } finally {
    try {
      zipfile.close();
    } catch {
      // no-op
    }
  }

  return { files: extracted, totalBytes };
}

// ---------------------------------------------------------------------------

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) {
        reject(
          new ZipExtractionError(
            'zip.invalid',
            err?.message ?? 'cannot open zip',
          ),
        );
        return;
      }
      resolve(zf);
    });
  });
}

function openReadStream(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('no stream'));
        return;
      }
      resolve(stream);
    });
  });
}

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  return /\/$/.test(entry.fileName);
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  // External file attributes (UNIX-Permissions) liegen in den oberen 16 Bit.
  // Symlink = Mode 0o120000.
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}
