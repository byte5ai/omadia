import {
  INGEST_CONFLICT_CODES,
  type IngestFailure,
} from './packageUploadService.js';

/**
 * #1477 — ONE answer for an ingest refusal, whichever door the package came
 * through.
 *
 * Three routes feed `PackageUploadService.ingest`: the ZIP upload
 * (`routes/packages.ts`), the Hub install (`routes/registryInstall.ts`) and the
 * builder install (`plugins/builder/installCommit.ts`). Each used to map the
 * pipeline's codes on its own, and they drifted: the Hub route answered 422
 * for conflicts the upload answered 409 and dropped `params`/`details`, and the
 * builder answered `package.incompatible_core` and every `zip.*` code with 500.
 * The status and the body now come from here, so a code added to the pipeline
 * changes all three at once.
 */

/** The status family an ingest refusal belongs to. */
export type IngestFailureStatus = 409 | 413 | 422;

const TOO_LARGE_CODES: ReadonlySet<string> = new Set([
  'package.too_large',
  'zip.file_too_large',
  'zip.total_too_large',
]);

/**
 * HTTP status for an ingest refusal:
 *
 *   409 — the package is fine, this host says no: an id is taken, the version
 *         is already there or older than the installed one
 *         (`INGEST_CONFLICT_CODES`), or its `compat.core` range excludes this
 *         host's `@omadia/plugin-api` (`package.incompatible_core`).
 *   413 — the archive or its extracted content is over a size cap.
 *   422 — everything else: the package itself has to change (bad manifest,
 *         bad zip, path escape, forbidden file, failing `onMigrate`, …).
 *
 * 422 is the default on purpose. Every code the pipeline emits names a fault
 * in what the caller sent or in the host state above; none of them is a
 * malformed REQUEST (400), and a code nobody has mapped yet must not turn
 * into a server fault (500).
 */
export function ingestFailureStatus(code: string): IngestFailureStatus {
  if (INGEST_CONFLICT_CODES.has(code) || code === 'package.incompatible_core') {
    return 409;
  }
  if (TOO_LARGE_CODES.has(code)) return 413;
  return 422;
}

/** The wire shape of an ingest refusal: what the client needs to localize it
 *  (`code` + `params`) and to explain it (`details`). */
export interface IngestErrorBody {
  code: string;
  message: string;
  params?: Record<string, string>;
  details?: unknown;
}

export function ingestFailureBody(
  failure: Pick<IngestFailure, 'code' | 'message' | 'params' | 'details'>,
): IngestErrorBody {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.params !== undefined ? { params: failure.params } : {}),
    ...(failure.details !== undefined ? { details: failure.details } : {}),
  };
}
