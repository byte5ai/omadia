'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { renderCell, ROWS_PER_PAGE, tdCls, thCls, type DetailState } from './shared';

/** Schema table + paginated row preview for the one expanded dataset. */
export function DatasetDetail({
  detail,
  onPage,
}: {
  detail: DetailState;
  onPage: (offset: number) => void;
}): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();

  if (detail.error !== null) {
    return (
      <p className="mt-4 border-t border-[color:var(--border)] pt-4 text-sm text-[color:var(--danger)]">
        {detail.error}
      </p>
    );
  }
  if (detail.dataset === null) {
    return (
      <p className="mt-4 border-t border-[color:var(--border)] pt-4 text-sm opacity-70">
        {t('loading')}
      </p>
    );
  }

  const columns = detail.dataset.columns;
  const from = detail.totalMatched === 0 ? 0 : detail.offset + 1;
  const to = Math.min(detail.offset + detail.rows.length, detail.totalMatched);

  return (
    <div className="mt-4 border-t border-[color:var(--border)] pt-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {t('schemaHeading')}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-[color:var(--fg-muted)]">
              <th className={thCls}>{t('schema.column')}</th>
              <th className={thCls}>{t('schema.type')}</th>
              <th className={thCls}>{t('schema.sample')}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.name} className="border-t border-[color:var(--border)]">
                <td className={tdCls}>{c.name}</td>
                <td className={`${tdCls} font-mono`}>{c.type}</td>
                <td className={`${tdCls} text-[color:var(--fg-muted)]`}>
                  {c.sample ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {t('rowsHeading')}
      </h3>
      {detail.loading ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : detail.rows.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('noRows')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-[color:var(--fg-muted)]">
                  {columns.map((c) => (
                    <th key={c.name} className={thCls}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((row, i) => (
                  <tr
                    key={detail.offset + i}
                    className="border-t border-[color:var(--border)]"
                  >
                    {columns.map((c) => (
                      <td key={c.name} className={tdCls}>
                        {renderCell(row[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-[13px] text-[color:var(--fg-muted)]">
              {t('rowsRange', {
                from: format.number(from),
                to: format.number(to),
                total: format.number(detail.totalMatched),
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onPage(Math.max(0, detail.offset - ROWS_PER_PAGE))}
                disabled={detail.offset === 0}
              >
                {t('previousPage')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onPage(detail.offset + ROWS_PER_PAGE)}
                disabled={to >= detail.totalMatched}
              >
                {t('nextPage')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
