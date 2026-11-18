'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '../../../_components/ui/Button';
import { cn } from '../../../_lib/cn';
import {
  listMissReports,
  resolveMissReport,
  type MissReportDto,
  type MissReportStatusFilter,
} from '../../../_lib/privacyReports';
import { receiptHref } from '../../../_lib/receipts';

interface MissReportListProps {
  initial: MissReportDto[];
}

/** #1552 — the filter tabs, in display order, with their catalog leaves. */
const FILTERS: ReadonlyArray<[MissReportStatusFilter, string]> = [
  ['open', 'filterOpen'],
  ['resolved', 'filterResolved'],
  ['all', 'filterAll'],
];

const EMPTY_KEYS: Record<MissReportStatusFilter, string> = {
  open: 'empty',
  resolved: 'emptyResolved',
  all: 'emptyAll',
};

/** Turn ids are long; the row shows a prefix and keeps the full id in the title. */
const TURN_ID_PREFIX_LENGTH = 8;

/**
 * #760 — open miss reports, newest first. Each row: the reported term (with
 * copy-to-clipboard, ready to paste into the privacy plugin's `custom_terms`
 * setup field), reporter, time, optional description — and a resolve button
 * for when the reviewer has added the rule (or decided none is needed).
 *
 * #1552 — each row links the turn it was filed from to that turn's receipt,
 * and a filter lists resolved reports with who resolved them and when.
 */
export function MissReportList({ initial }: MissReportListProps): React.ReactElement {
  const t = useTranslations('operatorPrivacyReports');
  const format = useFormatter();
  const [items, setItems] = useState<MissReportDto[]>(initial);
  const [filter, setFilter] = useState<MissReportStatusFilter>('open');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function changeFilter(next: MissReportStatusFilter): Promise<void> {
    if (next === filter || loading) return;
    const previous = filter;
    setFilter(next);
    setLoading(true);
    setError(null);
    try {
      const fresh = await listMissReports(next);
      setItems(fresh.items);
    } catch {
      setFilter(previous);
      setError(t('loadError'));
    } finally {
      setLoading(false);
    }
  }

  async function resolve(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await resolveMissReport(id);
      const fresh = await listMissReports(filter);
      setItems(fresh.items);
    } catch {
      setError(t('resolveFailed'));
    } finally {
      setBusyId(null);
    }
  }

  function formatWhen(iso: string): string {
    return format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function copyTerm(id: string, term: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(term);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
    } catch {
      // Clipboard unavailable (permissions) — the term is visible to copy manually.
    }
  }

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label={t('filterLabel')}
        className="flex flex-wrap gap-2"
      >
        {FILTERS.map(([value, labelKey]) => (
          <Button
            key={value}
            type="button"
            variant={filter === value ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={filter === value}
            disabled={loading}
            onClick={() => void changeFilter(value)}
          >
            {t(labelKey)}
          </Button>
        ))}
      </div>
      {error ? <p className="text-sm text-[color:var(--danger)]">{error}</p> : null}
      {items.length === 0 ? (
        <p className="rounded border border-[color:var(--edge)] p-6 text-sm text-[color:var(--fg-muted)]">
          {t(EMPTY_KEYS[filter])}
        </p>
      ) : (
        <>
          {filter !== 'resolved' ? (
            <p className="text-sm text-[color:var(--fg-muted)]">{t('howToResolve')}</p>
          ) : null}
          <ul className={cn('space-y-3', loading && 'opacity-60')}>
            {items.map((item) => (
              <MissReportRow
                key={item.id}
                item={item}
                busy={busyId === item.id}
                copied={copiedId === item.id}
                formatWhen={formatWhen}
                onCopy={() => void copyTerm(item.id, item.term)}
                onResolve={() => void resolve(item.id)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface MissReportRowProps {
  item: MissReportDto;
  busy: boolean;
  copied: boolean;
  formatWhen: (iso: string) => string;
  onCopy: () => void;
  onResolve: () => void;
}

function MissReportRow({
  item,
  busy,
  copied,
  formatWhen,
  onCopy,
  onResolve,
}: MissReportRowProps): React.ReactElement {
  const t = useTranslations('operatorPrivacyReports');
  const isResolved = item.status === 'resolved';
  return (
    <li
      data-testid={`miss-report-${item.id}`}
      className="rounded border border-[color:var(--edge)] p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <code className="rounded bg-[color:var(--bg-subtle)] px-2 py-1 text-sm">{item.term}</code>
        <Button type="button" variant="ghost" size="sm" onClick={onCopy}>
          {copied ? t('copied') : t('copyTerm')}
        </Button>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {t('reportedBy', { reporter: item.reporter })} · {formatWhen(item.createdAt)}
        </span>
        {item.turnId ? (
          <span className="text-xs text-[color:var(--fg-muted)]">
            {t('turnLabel')}:{' '}
            <Link
              href={receiptHref(item.turnId)}
              title={t('turnLinkTitle', { turnId: item.turnId })}
              className="font-mono-num text-[color:var(--accent)] hover:underline"
            >
              {item.turnId.slice(0, TURN_ID_PREFIX_LENGTH)}
            </Link>
          </span>
        ) : null}
        <div className="ml-auto">
          {isResolved ? (
            <span className="rounded border border-[color:var(--edge)] px-1.5 text-xs text-[color:var(--fg-muted)]">
              {t('resolvedBadge')}
            </span>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              busy={busy}
              busyLabel={t('resolving')}
              onClick={onResolve}
            >
              {t('resolve')}
            </Button>
          )}
        </div>
      </div>
      {item.description ? (
        <p className="mt-2 text-sm text-[color:var(--fg-muted)]">{item.description}</p>
      ) : null}
      {isResolved && item.resolvedAt ? (
        <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
          {t('resolvedBy', {
            resolver: item.resolvedBy ?? '—',
            when: formatWhen(item.resolvedAt),
          })}
        </p>
      ) : null}
    </li>
  );
}
