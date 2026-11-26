/**
 * #1847 — what a CSV file looks like before it is parsed: its encoding, its
 * separator and unique header names. Dependency-free so both tabular parsers
 * (`datasetImport.ts`, `datasetImportXlsx.ts`) can use it without a cycle.
 */

export type CsvEncoding = 'utf-8' | 'windows-1252';

/**
 * CSV text from bytes. UTF-8 when the bytes are valid UTF-8 (a BOM is
 * dropped); otherwise Windows-1252, which Excel on Windows writes by default
 * and which covers Latin-1 for every printable byte. A lossy UTF-8 decode
 * stored U+FFFD for every umlaut, with no way back.
 */
export function decodeCsvBytes(bytes: Buffer): { text: string; encoding: CsvEncoding } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

export const CSV_DELIMITERS = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** Occurrences of `delimiter` in `line` outside double-quoted fields. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) count += 1;
  }
  return count;
}

/**
 * The separator of a CSV file: whichever of `,` `;` tab occurs most often in
 * the header line outside quotes. German Excel writes `;`; read with `,`, such
 * a file collapsed into one column or failed on the first quote. A tie or a
 * one-column file keeps `,`.
 */
export function sniffCsvDelimiter(text: string): CsvDelimiter {
  const header = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  let best: CsvDelimiter = ',';
  let bestCount = countOutsideQuotes(header, best);
  for (const delimiter of CSV_DELIMITERS) {
    const count = countOutsideQuotes(header, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** Trim + collapse internal whitespace in a header cell. */
function normalizeHeader(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Header names made unique and non-empty, order kept. An unnamed column
 * becomes `column_<n>` (1-based position); a repeated name gets `_2`, `_3`, …
 * Rows are keyed by header name, so a collision silently dropped a column's
 * values. A suffix that is itself a header of the file is skipped, so
 * `a, a, a_2` becomes `a, a_3, a_2`.
 */
export function uniqueHeaders(rawHeaders: readonly string[]): string[] {
  const bases = rawHeaders.map((raw, idx) => normalizeHeader(raw) || `column_${String(idx + 1)}`);
  const taken = new Set<string>();
  const counts = new Map<string, number>();
  return bases.map((base) => {
    if (!taken.has(base)) {
      taken.add(base);
      counts.set(base, 1);
      return base;
    }
    let n = counts.get(base) ?? 1;
    let name: string;
    do {
      n += 1;
      name = `${base}_${String(n)}`;
    } while (taken.has(name) || bases.includes(name));
    counts.set(base, n);
    taken.add(name);
    return name;
  });
}
