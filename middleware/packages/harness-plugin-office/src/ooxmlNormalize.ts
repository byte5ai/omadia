import JSZip from 'jszip';

/**
 * Fixed mtime for every zip entry: 1980-01-01, the earliest date the DOS
 * date field of the zip format can hold. jszip derives the DOS fields from the
 * UTC getters (`getUTCFullYear() - 1980`), so an earlier date underflows the
 * 7-bit year and unzip tools show 2098 (#1977).
 */
const ZIP_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1));

/** `dcterms:created` / `dcterms:modified` elements in `docProps/core.xml`. */
const CORE_DATE_ELEMENT = /<dcterms:(created|modified)\b[^>]*>[^<]*<\/dcterms:\1>/g;

/**
 * Re-emit an OOXML (zip) buffer so two renders of the same descriptor are
 * byte-identical — the property the content-addressed cache in `officeService`
 * depends on (`store.exists(sha256(buffer))`).
 *
 * Why this pass has to exist: neither renderer library lets us keep the wall
 * clock out of the file.
 *   - exceljs and docx v9 write each **zip entry mtime** from `new Date()`
 *     (DOS 2-second granularity).
 *   - Both stamp `dcterms:created` / `dcterms:modified` into
 *     `docProps/core.xml`; docx v9 takes them from the wall clock and exposes
 *     no option to override them.
 * Without this pass every re-render produces a fresh sha256, so `store.exists`
 * never hits and the "idempotent re-renders hit the cache" contract is dead.
 *
 * This reloads the produced zip, pins every entry's mtime to `ZIP_ENTRY_DATE`,
 * and drops both `dcterms` dates from `core.xml`. Both are optional in OPC core
 * properties; the cache rules out the real render time, and any fixed value
 * would show up as a wrong "Created" date in Word/Excel, so the file carries
 * none (#1977). Entry order is preserved (the renderers already emit a stable
 * order), so re-deflating with a fixed compression level yields identical bytes
 * across renders.
 *
 * Nothing here touches the logical document — it only removes wall-clock bytes.
 */
export async function normalizeOoxml(buffer: Buffer): Promise<Buffer> {
  const input = await JSZip.loadAsync(buffer);
  const output = new JSZip();

  // `Object.keys` preserves load order, which mirrors the input central
  // directory — deterministic because the renderers emit entries in a stable
  // order and only the timestamps below vary between renders.
  for (const [name, entry] of Object.entries(input.files)) {
    if (entry.dir) continue;
    let content = await entry.async('nodebuffer');

    if (name === 'docProps/core.xml') {
      content = Buffer.from(content.toString('utf8').replace(CORE_DATE_ELEMENT, ''), 'utf8');
    }

    output.file(name, content, { date: ZIP_ENTRY_DATE, createFolders: false });
  }

  const out = await output.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
  return Buffer.from(out);
}
