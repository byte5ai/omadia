'use client';

import { ApiError, type DatasetSummary } from '../../../_lib/api';

/**
 * Shared constants, types, and helpers for Admin → Knowledge · Datasets
 * (#532, the admin half of #430). Split out of `page.tsx` to keep every file
 * under the repo's 500-line rule.
 */

/** Row-preview page size. Server clamps `limit` to [1, 200]. */
export const ROWS_PER_PAGE = 25;
/**
 * Dataset-list page size (#532 review must-fix 1: the endpoint used to serve
 * only its default 50 with no way to page past them). Matches the server's
 * old default so one page looks identical to the pre-pagination list.
 */
export const LIST_PER_PAGE = 50;
/** Mirrors `MAX_DATASET_ROWS` in `@omadia/orchestrator`'s `datasetImport.ts` —
 *  stated up front so an operator learns the cap before a 50 001-row CSV is
 *  rejected, not after. Display only; the server owns enforcement. */
export const MAX_DATASET_ROWS = 50_000;
/** Mirrors `MAX_UPLOAD_BYTES` in the datasets route (25 MiB), same reason. */
export const MAX_UPLOAD_MB = 25;

/** The expanded dataset's schema + current row page. */
export type DetailState = {
  id: string;
  dataset: DatasetSummary | null;
  rows: Array<Record<string, unknown>>;
  totalMatched: number;
  offset: number;
  loading: boolean;
  error: string | null;
};

export type TFn = (key: string, values?: Record<string, string | number>) => string;

export const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';
export const thCls =
  'px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]';
export const tdCls = 'px-2 py-1 align-top';

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * Cells arrive as `unknown` — the row store keeps the CSV's own values, which
 * are strings today but typed loosely enough that a future non-string backend
 * value would otherwise render as `[object Object]` or crash React.
 */
export function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The `dataset.*` codes the route emits, mapped to localized copy. Kept local
 * rather than added to `errorHelp.ts`: that catalogue's coverage test scopes it
 * to five specific route files and fails on codes from anywhere else as
 * orphans. Same local-mapping shape as `/admin/registries`.
 */
export function toFriendlyError(err: unknown, t: TFn): string {
  if (err instanceof ApiError) {
    if (err.status === 413 || err.code === 'dataset.limit_file_size') {
      return t('errors.tooLarge', { maxMb: MAX_UPLOAD_MB });
    }
    if (err.code === 'dataset.unsupported_type') return t('errors.notCsv');
    if (err.code === 'dataset.no_file') return t('errors.noFile');
    if (err.code === 'dataset.import_failed') {
      // The route's `reason` is the parser's own diagnostic (ragged rows, row
      // cap, empty file) and has no stable code behind it — surface it as
      // detail under a localized headline rather than as the headline.
      return t('errors.importFailed', { detail: apiMessage(err) });
    }
    if (err.code === 'dataset.not_found') return t('errors.notFound');
    return t('errors.generic', { status: err.status });
  }
  // Non-ApiError (network failure, programming error): localized headline,
  // raw diagnostic only as secondary detail — never as the primary copy.
  return t('errors.unexpected', {
    detail: err instanceof Error ? err.message : String(err),
  });
}

/** The server's untranslated `message`, for use as secondary detail only. */
function apiMessage(err: ApiError): string {
  try {
    const parsed = JSON.parse(err.body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : '';
  } catch {
    return '';
  }
}
