'use client';

import { useRef } from 'react';
import type { ChangeEvent, ReactElement } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertCircle, Loader2, Paperclip, X } from 'lucide-react';

import { CHAT_UPLOAD_ACCEPT, CHAT_UPLOAD_MAX_BYTES, type ComposerUpload } from '../../_lib/chatUploads';

/** #2336 — the paper-clip button that opens the file picker. */
export function AttachFileButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}): ReactElement {
  const t = useTranslations('chat.uploads');
  const format = useFormatter();
  const inputRef = useRef<HTMLInputElement>(null);
  const maxMb = format.number(CHAT_UPLOAD_MAX_BYTES / (1024 * 1024), { maximumFractionDigits: 0 });
  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onFiles(Array.from(event.target.files ?? []));
    // The same file can be attached again after removing it.
    event.target.value = '';
  };
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={CHAT_UPLOAD_ACCEPT}
        className="hidden"
        onChange={onChange}
        data-testid="chat-upload-input"
      />
      {/* eslint-disable-next-line no-restricted-syntax -- icon-only composer chrome like the reset button beside it, not a §4.2 Button candidate */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-2 text-[color:var(--fg-muted)] transition hover:border-[color:var(--border-strong)] hover:text-[color:var(--fg)] disabled:cursor-not-allowed disabled:opacity-30"
        title={t('attachTitle', { maxMb })}
        aria-label={t('attachAriaLabel')}
      >
        <Paperclip size={16} aria-hidden />
      </button>
    </>
  );
}

/** #2336 — the files attached to the message being written. */
export function ComposerAttachmentList({
  uploads,
  onRemove,
}: {
  uploads: readonly ComposerUpload[];
  onRemove: (localId: string) => void;
}): ReactElement | null {
  const t = useTranslations('chat.uploads');
  const format = useFormatter();
  if (uploads.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t('listAriaLabel')}>
      {uploads.map((upload) => (
        <li
          key={upload.localId}
          className={[
            'flex max-w-[16rem] items-center gap-1.5 rounded border px-2 py-1 text-xs',
            upload.status === 'error'
              ? 'border-[color:var(--danger-edge)] text-[color:var(--danger)]'
              : 'border-[color:var(--border)] bg-[color:var(--bg-elevated)] text-[color:var(--fg)]',
          ].join(' ')}
          title={upload.error ? t(`error.${upload.error}`) : upload.fileName}
        >
          {upload.status === 'uploading' && (
            <Loader2 size={12} className="animate-spin" aria-label={t('uploading')} />
          )}
          {upload.status === 'error' && <AlertCircle size={12} aria-hidden />}
          <span className="truncate">{upload.fileName}</span>
          <span className="shrink-0 text-[color:var(--fg-subtle)]">
            {upload.status === 'error' && upload.error
              ? t(`error.${upload.error}`)
              : formatSize(format, upload.sizeBytes)}
          </span>
          {/* eslint-disable-next-line no-restricted-syntax -- inline chip remove control, not a §4.2 Button candidate */}
          <button
            type="button"
            onClick={() => onRemove(upload.localId)}
            className="shrink-0 rounded p-0.5 hover:bg-[color:var(--bg)]"
            aria-label={t('removeAriaLabel', { name: upload.fileName })}
          >
            <X size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A file size in KB or MB, in the active locale. */
export function formatSize(format: ReturnType<typeof useFormatter>, bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return format.number(bytes / (1024 * 1024), { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
  }
  return format.number(Math.max(1, Math.round(bytes / 1024)), { style: 'unit', unit: 'kilobyte' });
}
