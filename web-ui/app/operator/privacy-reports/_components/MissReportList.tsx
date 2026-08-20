'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '../../../_components/ui/Button';
import {
  listMissReports,
  resolveMissReport,
  type MissReportDto,
} from '../../../_lib/privacyReports';

interface MissReportListProps {
  initial: MissReportDto[];
}

/**
 * #760 — open miss reports, newest first. Each row: the reported term (with
 * copy-to-clipboard, ready to paste into the privacy plugin's `custom_terms`
 * setup field), reporter, time, optional description — and a resolve button
 * for when the reviewer has added the rule (or decided none is needed).
 */
export function MissReportList({ initial }: MissReportListProps): React.ReactElement {
  const t = useTranslations('operatorPrivacyReports');
  const format = useFormatter();
  const [items, setItems] = useState<MissReportDto[]>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function resolve(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await resolveMissReport(id);
      const fresh = await listMissReports('open');
      setItems(fresh.items);
    } catch {
      setError(t('resolveFailed'));
    } finally {
      setBusyId(null);
    }
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

  if (items.length === 0) {
    return (
      <p className="rounded border border-[color:var(--edge)] p-6 text-sm text-[color:var(--fg-muted)]">
        {t('empty')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[color:var(--fg-muted)]">{t('howToResolve')}</p>
      {error ? <p className="text-sm text-[color:var(--danger)]">{error}</p> : null}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded border border-[color:var(--edge)] p-4">
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded bg-[color:var(--bg-subtle)] px-2 py-1 text-sm">{item.term}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void copyTerm(item.id, item.term)}
              >
                {copiedId === item.id ? t('copied') : t('copyTerm')}
              </Button>
              <span className="text-xs text-[color:var(--fg-muted)]">
                {t('reportedBy', { reporter: item.reporter })} ·{' '}
                {format.dateTime(new Date(item.createdAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
              <div className="ml-auto">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  busy={busyId === item.id}
                  busyLabel={t('resolving')}
                  onClick={() => void resolve(item.id)}
                >
                  {t('resolve')}
                </Button>
              </div>
            </div>
            {item.description ? (
              <p className="mt-2 text-sm text-[color:var(--fg-muted)]">{item.description}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
