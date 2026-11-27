'use client';

import type { ReactElement } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { FileAudio, FileImage, FileSpreadsheet, FileText } from 'lucide-react';

import type { MessageUpload } from '../../_lib/chatSessions';
import { formatSize } from './ComposerAttachments';

function iconFor(contentType: string): typeof FileText {
  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) return FileAudio;
  if (contentType.startsWith('image/')) return FileImage;
  if (contentType === 'text/csv' || contentType.includes('spreadsheet')) return FileSpreadsheet;
  return FileText;
}

/** #2336 — the files a sent user message carried. */
export function MessageUploads({ uploads }: { uploads: readonly MessageUpload[] }): ReactElement | null {
  const t = useTranslations('chat.uploads');
  const format = useFormatter();
  if (uploads.length === 0) return null;
  return (
    <ul className="mb-1 flex flex-wrap justify-end gap-1.5" aria-label={t('sentListAriaLabel')}>
      {uploads.map((upload, index) => {
        const Icon = iconFor(upload.contentType);
        return (
          <li
            key={`${upload.fileName}-${String(index)}`}
            className="flex max-w-[16rem] items-center gap-1.5 rounded bg-[color:var(--fg-on-dark)]/10 px-2 py-1 text-xs"
            title={upload.fileName}
          >
            <Icon size={12} aria-hidden />
            <span className="truncate">{upload.fileName}</span>
            <span className="shrink-0 opacity-70">{formatSize(format, upload.sizeBytes)}</span>
          </li>
        );
      })}
    </ul>
  );
}
