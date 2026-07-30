'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import type { DiffLine } from '../_lib/lineDiff';
import { summarizeToolCall, type ToolCallDetail, type ToolCallEntry } from '../_lib/toolCallLog';

/**
 * Epic #470 — one structured entry in the implement-phase log pane (see
 * `JobLogPane.tsx`), replacing the previous flat `$ Name {...raw JSON...}`
 * text line. Collapsed by default: an icon-free status glyph, the tool
 * name, and `summarizeToolCall`'s one-line headline; expanding reveals the
 * tool-shaped detail (a diff for `Edit`, a command + output for `Bash`,
 * etc.). Text/edge-only state coloring, no spinners — this project's Lume
 * design rules (see `lume-design-system-web-ui`).
 */

const STATUS_GLYPH: Record<ToolCallEntry['status'], string> = {
  pending: '…',
  ok: '✓',
  error: '✕',
};

const STATUS_CLASS: Record<ToolCallEntry['status'], string> = {
  pending: 'text-[color:var(--fg-subtle)]',
  ok: 'text-[color:var(--fg-strong)]',
  error: 'text-[color:var(--danger)]',
};

const DIFF_LINE_LIMIT = 400;

export function ToolCallCard({ entry }: { entry: ToolCallEntry }): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail.toolCall');
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolCall(entry);
  const statusLabel = entry.status === 'pending' ? t('pending') : entry.status === 'error' ? t('failed') : '';

  return (
    <div className="my-1 rounded-md border border-[color:var(--border)] px-2 py-1.5 font-mono text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={expanded}
      >
        <span aria-hidden className={STATUS_CLASS[entry.status]}>
          {STATUS_GLYPH[entry.status]}
        </span>
        <span className="shrink-0 text-[color:var(--fg-strong)]">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate text-[color:var(--fg-muted)]">{summary.headline}</span>
        {summary.detail.kind === 'diff' ? (
          <span className="shrink-0">
            <span className="text-[color:var(--ok)]">+{summary.detail.added}</span>{' '}
            <span className="text-[color:var(--danger)]">-{summary.detail.removed}</span>
          </span>
        ) : null}
        {statusLabel ? (
          <span className={`shrink-0 uppercase tracking-[0.12em] ${STATUS_CLASS[entry.status]}`}>{statusLabel}</span>
        ) : null}
        <span aria-hidden className="shrink-0 text-[color:var(--fg-subtle)]">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded ? <div className="mt-1.5 border-l border-[color:var(--divider)] pl-3">{renderDetail(summary.detail, t)}</div> : null}
    </div>
  );
}

function renderDetail(
  detail: ToolCallDetail,
  t: ReturnType<typeof useTranslations<'adminDevPlatform.detail.toolCall'>>,
): React.ReactElement {
  switch (detail.kind) {
    case 'diff':
      return <DiffView diff={detail.diff} t={t} />;
    case 'command':
      return (
        <>
          <Pre text={`$ ${detail.command}`} tone="strong" />
          <OutputBlock text={detail.output} label={t('output')} t={t} />
        </>
      );
    case 'file':
      return <OutputBlock text={detail.preview} t={t} />;
    case 'agent':
      return (
        <>
          {detail.prompt ? <Pre text={detail.prompt} label={t('prompt')} /> : null}
          <OutputBlock text={detail.output} label={t('result')} t={t} />
        </>
      );
    case 'search':
      return <OutputBlock text={detail.output} t={t} />;
    case 'raw':
      return (
        <>
          {detail.input ? <Pre text={detail.input} /> : null}
          <OutputBlock text={detail.output} t={t} />
        </>
      );
  }
}

function OutputBlock({
  text,
  label,
  t,
}: {
  text: string | undefined;
  label?: string;
  t: ReturnType<typeof useTranslations<'adminDevPlatform.detail.toolCall'>>;
}): React.ReactElement {
  if (!text) return <p className="text-[color:var(--fg-subtle)]">{t('noOutput')}</p>;
  return <Pre text={text} label={label} />;
}

function Pre({ text, label, tone = 'muted' }: { text: string; label?: string; tone?: 'muted' | 'strong' }): React.ReactElement {
  return (
    <div className="mb-1 last:mb-0">
      {label ? <div className="mb-0.5 text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-subtle)]">{label}</div> : null}
      <pre
        className={`whitespace-pre-wrap break-words rounded lume-surface-sunken px-2 py-1 ${
          tone === 'strong' ? 'text-[color:var(--fg-strong)]' : 'text-[color:var(--fg-muted)]'
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

function DiffView({
  diff,
  t,
}: {
  diff: DiffLine[];
  t: ReturnType<typeof useTranslations<'adminDevPlatform.detail.toolCall'>>;
}): React.ReactElement {
  const shown = diff.slice(0, DIFF_LINE_LIMIT);
  const hidden = diff.length - shown.length;
  return (
    <div className="overflow-x-auto rounded border border-[color:var(--border)] lume-surface-sunken">
      <pre className="px-2 py-1 leading-[1.5]">
        {shown.map((line, i) => (
          <div
            key={i}
            className={
              line.type === 'add'
                ? 'text-[color:var(--ok)]'
                : line.type === 'remove'
                  ? 'text-[color:var(--danger)]'
                  : 'text-[color:var(--fg-subtle)]'
            }
          >
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '} {line.text}
          </div>
        ))}
      </pre>
      {hidden > 0 ? (
        <div className="border-t border-[color:var(--border)] px-2 py-1 text-[color:var(--fg-subtle)]">
          {t('moreDiffLines', { count: hidden })}
        </div>
      ) : null}
    </div>
  );
}
