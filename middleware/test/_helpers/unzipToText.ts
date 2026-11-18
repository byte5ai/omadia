/**
 * Extract every file entry of an OOXML (zip) buffer as UTF-8 text. Mirrors the
 * `unzipToMap` helper in profileBundle.test.ts. The office suites read the raw
 * parts (`docProps/*.xml`, `xl/worksheets/sheet1.xml`, `xl/workbook.xml`) back
 * out of the produced file rather than trusting the renderer input; `.docx`
 * exposes no reader, and ExcelJS cannot read `calcPr` attributes back.
 *
 * Shared by `office.test.ts` and `office-formulas.test.ts`.
 */
export async function unzipToText(buf: Buffer): Promise<Map<string, string>> {
  const yauzl = await import('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err ?? new Error('cannot open buffer'));
      const out = new Map<string, string>();
      zf.readEntry();
      zf.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zf.readEntry();
          return;
        }
        zf.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zf.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zf.on('end', () => resolve(out));
      zf.on('error', reject);
    });
  });
}
