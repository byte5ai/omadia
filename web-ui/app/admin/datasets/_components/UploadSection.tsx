'use client';

import { useCallback, useRef, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { uploadDataset, type DatasetUploadResponse } from '../../../_lib/api';
import {
  Field,
  inputCls,
  MAX_DATASET_ROWS,
  MAX_UPLOAD_MB,
  toFriendlyError,
} from './shared';

/**
 * CSV import form + the post-import receipt (privacy-scan and truncation
 * counts). Owns its own error slot so an upload failure can never be
 * mistaken for a list or delete failure (#532 review must-fix 3).
 */
export function UploadSection({
  onUploaded,
}: {
  /** Called after a successful import so the owner can refresh the list. */
  onUploaded: () => Promise<void>;
}): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [receipt, setReceipt] = useState<DatasetUploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * A file input is uncontrolled: clearing `file` state does NOT clear the
   * element, and re-picking the SAME file then fires no `change` event
   * (the element's value is unchanged), so state would stay `null` while the
   * element still shows a filename — the Import button dead with no
   * explanation. Reset the element itself after a successful import.
   */
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onUpload = useCallback(async (): Promise<void> => {
    if (!file) return;
    setError(null);
    setReceipt(null);
    setUploading(true);
    try {
      const result = await uploadDataset(file, name);
      setReceipt(result);
      setFile(null);
      setName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await onUploaded();
    } catch (err) {
      setError(toFriendlyError(err, t));
    } finally {
      setUploading(false);
    }
  }, [file, name, onUploaded, t]);

  return (
    <>
      <section className="mb-8 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-4 text-[15px] font-semibold text-[color:var(--fg-strong)]">
          {t('uploadHeading')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-[2fr_2fr_auto] sm:items-end">
          <Field label={t('fields.file')}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label={t('fields.file')}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setReceipt(null);
                setError(null);
              }}
              className={inputCls}
            />
          </Field>
          <Field label={t('fields.nameOptional')}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={file?.name ?? t('placeholders.name')}
              className={inputCls}
            />
          </Field>
          <Button
            variant="primary"
            onClick={() => void onUpload()}
            disabled={file === null || uploading}
            busy={uploading}
            busyLabel={t('uploading')}
          >
            {t('upload')}
          </Button>
        </div>
        <p className="mt-3 text-[13px] text-[color:var(--fg-muted)]">
          {t('uploadLimits', {
            maxRows: format.number(MAX_DATASET_ROWS),
            maxMb: format.number(MAX_UPLOAD_MB),
          })}
        </p>
      </section>

      {receipt !== null && (
        <section className="mb-8 rounded-lg border border-[color:var(--success)]/50 bg-[color:var(--success)]/8 p-4 text-sm">
          <p className="font-semibold text-[color:var(--success)]">
            {t('receipt.imported', {
              rows: format.number(receipt.dataset.rowCount),
            })}
          </p>
          <p className="mt-1 text-[color:var(--fg-muted)]">
            {t('receipt.privacyScan', {
              scanned: format.number(receipt.privacyScan.scannedCells),
              masked: format.number(receipt.privacyScan.maskedCells),
            })}
          </p>
          {receipt.truncation.truncatedCellCount > 0 && (
            <p className="mt-1 text-[color:var(--warning)]">
              {t('receipt.truncated', {
                cells: format.number(receipt.truncation.truncatedCellCount),
                columns: receipt.truncation.truncatedColumns.join(', '),
              })}
            </p>
          )}
        </section>
      )}

      {error !== null && (
        <p className="mb-6 text-sm text-[color:var(--danger)]">{error}</p>
      )}
    </>
  );
}
