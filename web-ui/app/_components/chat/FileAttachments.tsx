'use client';

import { useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { useTranslations } from 'next-intl';

import type { DiagramAttachment, OutgoingFileAttachment } from '../../_lib/chatSessions';
import {
  isSignedLinkExpired,
  useRenewableFileLink,
  type FileLinkFailure,
  type RenewableFileLink,
} from '../../_lib/fileLinkRenewal';

/**
 * Diagram images and file chips under an answer. Their links are signed and
 * expire (ADR-0137); an older message renews them through the kernel
 * (#1964, ADR-0266) instead of showing a broken image or a dead chip.
 */

/** On a click, an expired link is renewed first and then opened. */
function openFresh(link: RenewableFileLink) {
  return (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!isSignedLinkExpired(link.url)) return;
    event.preventDefault();
    void link.renew().then((fresh) => {
      if (fresh) window.open(fresh, '_blank', 'noreferrer');
    });
  };
}

function FileLinkNotice({
  renewing,
  failure,
}: {
  renewing: boolean;
  failure: FileLinkFailure | null;
}): ReactElement | null {
  const t = useTranslations('chat.fileLink');
  if (failure) {
    return (
      <p role="status" className="mt-1 text-xs text-[color:var(--warning)]">
        {t(failure)}
      </p>
    );
  }
  if (renewing) {
    return (
      <p role="status" className="mt-1 text-xs text-[color:var(--fg-muted)]">
        {t('renewing')}
      </p>
    );
  }
  return null;
}

function DiagramItem({ att }: { att: DiagramAttachment }): ReactElement {
  const t = useTranslations('chat');
  const link = useRenewableFileLink(att.url);
  // The renewed image failed as well (file deleted, store down): say so.
  const [brokenAfterRenew, setBrokenAfterRenew] = useState(false);
  const onImageError = (): void => {
    if (link.url !== att.url) setBrokenAfterRenew(true);
    else void link.renew();
  };
  return (
    <div>
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        onClick={openFresh(link)}
        className="block overflow-hidden rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-2 transition hover:border-[color:var(--border-strong)]"
        title={t('attachmentTitle', {
          kind: att.diagramKind,
          cachedSuffix: att.cacheHit ? t('attachmentCachedSuffix') : '',
        })}
      >
        {/* Plain <img>: Next's Image component would complain about the
            middleware origin without config, and these PNGs are cheap. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={link.url}
          alt={att.altText}
          onError={onImageError}
          className="mx-auto max-h-[500px] w-auto"
        />
        <div className="mt-1 text-[10px] text-[color:var(--fg-muted)]">
          {att.diagramKind}
          {att.cacheHit && ' · cached'}
          {' · '}
          <span className="font-mono">{att.altText}</span>
        </div>
      </a>
      <FileLinkNotice
        renewing={link.renewing}
        failure={link.failure ?? (brokenAfterRenew ? 'failed' : null)}
      />
    </div>
  );
}

/**
 * Renders diagram attachments (today only `render_diagram` PNGs) under the
 * markdown answer. Each image is wrapped in a link so clicking opens the full
 * resolution in a new tab — mirrors the Teams Adaptive-Card `selectAction`.
 */
export function AttachmentGrid({
  attachments,
}: {
  attachments: DiagramAttachment[];
}): ReactElement {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {attachments.map((att, idx) => (
        <DiagramItem key={`${att.url}-${String(idx)}`} att={att} />
      ))}
    </div>
  );
}

function FileItem({ file }: { file: OutgoingFileAttachment }): ReactElement {
  const link = useRenewableFileLink(file.url);
  return (
    <div>
      <a
        href={link.url}
        download={file.altText}
        target="_blank"
        rel="noreferrer"
        onClick={openFresh(link)}
        className="flex items-center gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-3 transition hover:border-[color:var(--border-strong)]"
      >
        <span aria-hidden className="text-xl">
          {fileGlyph(file)}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{file.altText}</span>
          <span className="text-[10px] uppercase text-[color:var(--fg-muted)]">
            {fileExt(file.altText)}
            {file.sizeBytes ? ` · ${formatFileSize(file.sizeBytes)}` : ''}
          </span>
        </span>
        <span className="ml-auto text-sm text-[color:var(--fg-subtle)]" aria-hidden>
          ↓
        </span>
      </a>
      <FileLinkNotice renewing={link.renewing} failure={link.failure} />
    </div>
  );
}

/**
 * Renders downloadable file attachments (e.g. `create_xlsx` / `create_docx`)
 * as a list of download links. Labels are extension-derived.
 */
export function FileAttachmentList({
  files,
}: {
  files: OutgoingFileAttachment[];
}): ReactElement {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {files.map((file, idx) => (
        <FileItem key={`${file.url}-${String(idx)}`} file={file} />
      ))}
    </div>
  );
}

function fileGlyph(file: OutgoingFileAttachment): string {
  const name = file.altText.toLowerCase();
  if (file.mediaType.includes('spreadsheet') || name.endsWith('.xlsx')) return '📊';
  if (file.mediaType.includes('word') || name.endsWith('.docx')) return '📄';
  return '📎';
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : 'file';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
