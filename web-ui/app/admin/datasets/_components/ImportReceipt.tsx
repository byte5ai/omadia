'use client';

import { useFormatter, useTranslations } from 'next-intl';

import type { DatasetImportedTable, DatasetUploadResponse } from '../../../_lib/api';

/**
 * #1844 — the post-import receipt: one block per imported table (a workbook
 * yields one dataset per sheet), and scan copy that says what was scanned
 * (text cells only) and what "flagged" means for the stored value.
 */
export function ImportReceipt({
  receipt,
}: {
  receipt: DatasetUploadResponse;
}): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();
  const tables: DatasetImportedTable[] =
    receipt.datasets && receipt.datasets.length > 0
      ? receipt.datasets
      : [{ dataset: receipt.dataset, privacyScan: receipt.privacyScan, truncation: receipt.truncation }];
  const totalRows = tables.reduce((sum, table) => sum + table.dataset.rowCount, 0);

  return (
    <section className="mb-8 rounded-lg border border-[color:var(--success)]/50 bg-[color:var(--success)]/8 p-4 text-sm">
      <p className="font-semibold text-[color:var(--success)]">
        {tables.length > 1
          ? t('receipt.importedSheets', {
              sheets: format.number(tables.length),
              rows: format.number(totalRows),
            })
          : t('receipt.imported', { rows: format.number(totalRows) })}
      </p>
      {tables.map((table) => (
        <div key={table.dataset.datasetId} className="mt-2">
          {table.sheetName !== undefined && tables.length > 1 && (
            <p className="font-medium text-[color:var(--fg-strong)]">
              {t('receipt.sheet', {
                sheet: table.sheetName,
                rows: format.number(table.dataset.rowCount),
              })}
            </p>
          )}
          <p className="mt-1 text-[color:var(--fg-muted)]">
            {t('receipt.privacyScan', {
              scanned: format.number(table.privacyScan.scannedCells),
              masked: format.number(table.privacyScan.maskedCells),
            })}
            {table.privacyScan.maskedCells > 0 && (
              <>
                {' '}
                {table.privacyScan.encryptedAtRest === true
                  ? t('receipt.flaggedEncrypted')
                  : t('receipt.flaggedMasked')}
              </>
            )}
          </p>
          {table.truncation.truncatedCellCount > 0 && (
            <p className="mt-1 text-[color:var(--warning)]">
              {t('receipt.truncated', {
                cells: format.number(table.truncation.truncatedCellCount),
                columns: table.truncation.truncatedColumns.join(', '),
              })}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
