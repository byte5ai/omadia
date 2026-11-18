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

import { errorHelpLine } from './errorHelp';

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
  // #1455 — an older version than the installed one, refused unless the
  // operator confirms the downgrade.
  'package.downgrade_blocked': [
    'downgradeBlocked',
    ['pluginId', 'fromVersion', 'toVersion'],
  ],
  'upload.no_file': ['noFile', []],
  // #1489 — a multipart body the server could not read (truncated, malformed).
  'upload.multipart': ['multipart', []],
  // #1488 — the archive itself. `entry` names the offending archive entry, so
  // the operator knows what to remove when rebuilding the package.
  'zip.invalid': ['zipInvalid', []],
  'zip.path_escape': ['zipPathEscape', ['entry']],
  'zip.symlink': ['zipSymlink', ['entry']],
  'zip.forbidden_extension': ['zipForbiddenExtension', ['entry']],
  'zip.too_many_entries': ['zipTooManyEntries', []],
  'zip.file_too_large': ['zipFileTooLarge', []],
  'zip.total_too_large': ['zipTotalTooLarge', []],
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

/** The parts of a middleware error envelope this module reads. */
export interface StoreErrorBody {
  code?: string;
  message?: string;
  params?: Readonly<Record<string, string>>;
}

/**
 * #1477 — one error text for every store surface that installs a package: the
 * upload dropzone, the install drawer, the update button. The Hub install now
 * answers ingest refusals with the same `code` + `params` as the upload, so the
 * drawer can say them in the operator's locale too; before, it printed the
 * server's German `message` in both locales.
 *
 * Order: an ingest code with its params (`store.upload.errors`), then the
 * error-help catalogue (`install.*`, `package.incompatible_core`, …), then the
 * server's own message, then `fallback`.
 *
 * @param tRoot a translator at the message ROOT, as `errorHelpLine` needs
 */
export function storeErrorText(
  body: StoreErrorBody | null,
  fallback: string,
  tUpload: Translator,
  tRoot: (key: string) => string,
): string {
  const serverText = body?.message ?? fallback;
  const code = body?.code;
  if (!code) return serverText;
  if (UPLOAD_ERRORS[code]) {
    return packageErrorText(code, body.params, serverText, tUpload);
  }
  return errorHelpLine(code, tRoot) ?? serverText;
}
