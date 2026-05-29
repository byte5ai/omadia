/**
 * Turn a user/LLM-supplied filename into a safe download name with the right
 * extension. Strips path separators, control chars, and quotes (so it can be
 * dropped into a `Content-Disposition` header and a storage key without
 * injection), collapses whitespace, and guarantees the extension.
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
