/**
 * #1401 — package upload rejections in the operator's locale.
 *
 * `packageUploadService.ts` writes its rejection messages in German (it has
 * no request locale), so the English UI showed e.g. "Version 0.3.3 von … ist
 * bereits hochgeladen." The response carries a stable `code` and, since
 * #1401, the `params` that text needs. This maps the codes an operator
 * actually meets to catalog keys under `store.upload.errors`. Any other code
 * — or a known code whose params are missing (an older server) — keeps the
 * server's own message.
 */

type Translator = (key: string, values?: Record<string, string>) => string;

/** code → [catalog key, params the text requires]. */
export const UPLOAD_ERRORS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  'package.too_large': ['tooLarge', ['maxBytes']],
  // The size limit multer enforces first, with the same number.
  'upload.limit_file_size': ['tooLarge', ['maxBytes']],
  'package.manifest_missing': ['manifestMissing', []],
  'package.manifest_invalid': ['manifestInvalid', []],
  'package.id_mismatch': ['idMismatch', ['packageName', 'pluginId']],
  'package.version_mismatch': ['versionMismatch', ['packageVersion', 'pluginVersion']],
  'package.entry_missing': ['entryMissing', ['entry']],
  'package.id_conflict_bundled': ['idConflictBundled', ['pluginId', 'overrideEnv']],
  'package.id_conflict_builtin': ['idConflictBuiltin', ['pluginId']],
  'package.duplicate_version': ['duplicateVersion', ['pluginId', 'version']],
  'upload.no_file': ['noFile', []],
};

export function packageErrorText(
  code: string,
  params: Readonly<Record<string, string>> | undefined,
  fallback: string,
  t: Translator,
): string {
  const entry = UPLOAD_ERRORS[code];
  if (!entry) return fallback;
  const [key, needed] = entry;
  const values: Record<string, string> = {};
  for (const name of needed) {
    const v = params?.[name];
    if (typeof v !== 'string') return fallback;
    values[name] = v;
  }
  return t(key, values);
}
