/**
 * Turn a user/LLM-supplied filename into a safe download name with the right
 * extension. Strips path separators, control chars, and quotes (so it can be
 * used as a storage key and a download name without injection), collapses
 * whitespace, and guarantees the extension. Non-ASCII letters are kept; the
 * header encoding for them is `attachmentDisposition`'s job.
 */

// Characters unsafe in a Content-Disposition header or a Windows filename,
// plus a control-char sweep via the Unicode \p{Cc} class (covers CR/LF → no
// header injection; using the property escape keeps eslint's no-control-regex
// happy). Spaces and hyphens are intentionally preserved.
const ILLEGAL_FILENAME_CHARS = /[\p{Cc}"'`<>:|?*]+/gu;
const PATH_SEPARATORS = /[\\/]+/g;
const TRAILING_EXT = /\.(xlsx|docx)$/i;

export function sanitizeFilename(
  raw: string | undefined,
  ext: 'xlsx' | 'docx',
  fallbackBase: string,
): string {
  const source = raw && raw.trim().length > 0 ? raw : fallbackBase;
  const base = source
    .replace(PATH_SEPARATORS, ' ')
    .replace(ILLEGAL_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING_EXT, '')
    .slice(0, 100)
    .trim();
  const safeBase = base.length > 0 ? base : fallbackBase;
  return `${safeBase}.${ext}`;
}

// Anything a quoted-string `filename=` cannot carry safely in every client:
// non-printable or non-ASCII characters, plus the quote and backslash that
// would end or escape the quoted value.
const NON_HEADER_SAFE = /[^\x20-\x7e]|["\\]/g;
// Combining marks left over after NFKD, so "Ü" falls back to "U", not "_".
const COMBINING_MARKS = /\p{M}/gu;

/**
 * `Content-Disposition` value that makes the browser save the file under
 * `filename` (RFC 6266). The header stays plain ASCII: `filename=` carries an
 * ASCII fallback, and a name with other characters ("Übersicht Größe",
 * "Umsatz – Q3 €") is added as `filename*=UTF-8''<percent-encoded>`
 * (RFC 8187), which every current browser prefers.
 */
export function attachmentDisposition(filename: string): string {
  const fallback = filename
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(NON_HEADER_SAFE, '_');
  if (fallback === filename) return `attachment; filename="${filename}"`;
  // encodeURIComponent leaves `!'()*` unescaped; RFC 8187 only allows `!`.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
