import JSZip from 'jszip';
import { DETERMINISTIC_EPOCH } from './types.js';

/**
 * Re-emit an OOXML (zip) buffer so two renders of the same descriptor are
 * byte-identical — the property the content-addressed cache in `officeService`
 * depends on (`store.exists(sha256(buffer))`).
 *
 * Why this pass has to exist: neither renderer library lets us pin the wall
 * clock it stamps into the file.
 *   - exceljs writes each **zip entry mtime** from `new Date()` (DOS 2-second
 *     granularity), independent of the `DETERMINISTIC_EPOCH` it honours for the
 *     core-property timestamps.
 *   - docx v9 additionally stamps `dcterms:created` / `dcterms:modified` in
 *     `docProps/core.xml` from the wall clock and exposes no option to override
 *     them (`IPropertiesOptions` carries no `created`/`modified` field).
 * Without this pass every re-render produces a fresh sha256, so `store.exists`
 * never hits and the "idempotent re-renders hit the cache" contract is dead.
 *
 * This reloads the produced zip, pins every entry's mtime to
 * `DETERMINISTIC_EPOCH`, and — when `rewriteCoreDates` is set — rewrites the
 * `dcterms` timestamps in `core.xml` to the same epoch. Entry order is
 * preserved (the renderers already emit a stable order), so re-deflating with a
 * fixed compression level yields identical bytes across renders. The zip DOS
 * time is derived from the epoch in the running process's timezone; that is
 * constant within a deployment, which is all content-addressing requires.
 *
 * Nothing here touches the logical document — it only removes wall-clock bytes.
 */
export async function normalizeOoxml(
  buffer: Buffer,
  opts: { readonly rewriteCoreDates?: boolean } = {},
): Promise<Buffer> {
  const epochIso = DETERMINISTIC_EPOCH.toISOString();
  const input = await JSZip.loadAsync(buffer);
  const output = new JSZip();

  // `Object.keys` preserves load order, which mirrors the input central
  // directory — deterministic because the renderers emit entries in a stable
  // order and only the timestamps below vary between renders.
  for (const [name, entry] of Object.entries(input.files)) {
    if (entry.dir) continue;
    let content = await entry.async('nodebuffer');

    if (opts.rewriteCoreDates && name === 'docProps/core.xml') {
      content = Buffer.from(
        content
          .toString('utf8')
          .replace(
            /(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/,
            `$1${epochIso}$2`,
          )
          .replace(
            /(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/,
            `$1${epochIso}$2`,
          ),
        'utf8',
      );
    }

    output.file(name, content, { date: DETERMINISTIC_EPOCH, createFolders: false });
  }

  const out = await output.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
  return Buffer.from(out);
}
