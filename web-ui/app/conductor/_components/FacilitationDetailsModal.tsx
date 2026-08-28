'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  getConductorRun,
  type ConductorRunResult,
  type FacilitationOverview,
} from '@/app/_lib/api';

import { ConductorRunTrace } from './ConductorRunTrace';
import { splitDod } from './FacilitationsPanel';

/**
 * #330 round 4 follow-up — "wo stehen wir gerade?" as a modal: the card's
 * summary plus the FULL durable run trace (every assess round with its
 * postcondition outcome and the transition taken). Read-only; the destructive
 * action stays on the card. Plain overlay in the ConfirmDialog style.
 */
export function FacilitationDetailsModal({
  facilitation,
  onClose,
}: {
  facilitation: FacilitationOverview;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const format = useFormatter();
  const [trace, setTrace] = useState<ConductorRunResult | null>(null);
  const [traceError, setTraceError] = useState(false);
  const f = facilitation;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const loadTrace = useCallback(async () => {
    if (!f.run) return;
    setTraceError(false);
    try {
      setTrace(await getConductorRun(f.slug, f.run.id));
    } catch {
      setTraceError(true);
    }
  }, [f.slug, f.run]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader (same pattern as ConductorRunHistory)
    void loadTrace();
  }, [loadTrace]);

  const dodItems = f.run?.definitionOfDone ? splitDod(f.run.definitionOfDone) : null;
  const verdictItems = f.run?.lastVerdict?.items ?? null;

  const statusLabel = (status: 'done' | 'partial' | 'open' | null): string =>
    status === 'done'
      ? t('facilitationStatusDone')
      : status === 'partial'
        ? t('facilitationStatusPartial')
        : status === 'open'
          ? t('facilitationStatusOpen')
          : '—';

  const statusColor = (status: 'done' | 'partial' | 'open' | null): string =>
    status === 'done'
      ? 'var(--success,#30a46c)'
      : status === 'partial'
        ? 'var(--warning,#f5a623)'
        : 'var(--fg-muted)';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('facilitationDetailsHeading')}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- invisible backdrop click-catcher, not a §4.2 CTA */}
      <button
        type="button"
        aria-label={t('facilitationDetailsClose')}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated,var(--card))] shadow-lg">
        <header className="flex items-start justify-between gap-4 border-b border-[color:var(--border)] px-6 py-4">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[color:var(--fg-subtle,var(--fg-muted))]">
              {t('facilitationDetailsHeading')}
            </div>
            <h3 className="mt-1 text-[17px] font-semibold leading-snug text-[color:var(--fg-strong)]">
              {f.run?.goal ?? f.name}
            </h3>
            {f.conversation && (
              <p className="mt-1 truncate font-mono text-[11px] text-[color:var(--fg-muted)]">
                {f.conversation.channelType} · {f.conversation.conversationId}
              </p>
            )}
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t('facilitationDetailsClose')}
          </Button>
        </header>
        <div className="grid gap-4 overflow-y-auto px-6 py-4 text-[13px]">
          {f.run?.lastVerdict && (
            <div className="rounded-md border border-[color:var(--border)] bg-black/10 px-3 py-2">
              <span className="font-medium text-[color:var(--fg-strong)]">{t('facilitationLastVerdict')}: </span>
              <span
                style={{
                  color:
                    f.run.lastVerdict.dodMet === true
                      ? 'var(--success,#30a46c)'
                      : f.run.lastVerdict.dodMet === false
                        ? 'var(--warning,#f5a623)'
                        : 'var(--fg-muted)',
                }}
              >
                {f.run.lastVerdict.dodMet === true
                  ? t('facilitationDodMet')
                  : f.run.lastVerdict.dodMet === false
                    ? t('facilitationDodOpen')
                    : '—'}
              </span>
              {f.run.lastVerdict.summary && (
                <span className="text-[color:var(--fg-muted)]"> — {f.run.lastVerdict.summary}</span>
              )}
            </div>
          )}
          {verdictItems && verdictItems.length > 0 && (
            <div>
              <p id="facilitation-results-heading" className="mb-1 font-medium text-[color:var(--fg-strong)]">
                {t('facilitationResultsHeading')}
              </p>
              {/* Focusable so keyboard users can horizontally scroll an overflowing table. */}
              <div
                className="overflow-x-auto rounded-md border border-[color:var(--border)]"
                role="region"
                aria-labelledby="facilitation-results-heading"
                tabIndex={0}
              >
                <table className="w-full border-collapse text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-[color:var(--border)] bg-black/10 text-[11px] uppercase tracking-wide text-[color:var(--fg-muted)]">
                      <th scope="col" className="px-3 py-2 font-medium">#</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('facilitationResultsPoint')}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('facilitationResultsStatus')}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('facilitationResultsNote')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verdictItems.map((item, idx) => (
                      <tr key={idx} className="border-b border-[color:var(--border)] align-top last:border-b-0">
                        <td className="px-3 py-2 text-[color:var(--fg-muted)]">{item.point ?? idx + 1}</td>
                        <td className="px-3 py-2 text-[color:var(--fg-strong)]">{item.label ?? '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-medium" style={{ color: statusColor(item.status) }}>
                          {statusLabel(item.status)}
                        </td>
                        <td className="px-3 py-2 text-[color:var(--fg-muted)]">{item.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {/* The table's point labels are a model paraphrase — the authoritative DoD text
              stays visible alongside it (review M1). */}
          {f.run?.definitionOfDone && (
            <div className="text-[color:var(--fg-muted)]">
              <p className="mb-1 font-medium text-[color:var(--fg-strong)]">{t('facilitationDod')}</p>
              {dodItems ? (
                <ol className="list-decimal space-y-0.5 pl-5">
                  {dodItems.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ol>
              ) : (
                <p>{f.run.definitionOfDone}</p>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-[color:var(--fg-muted)]">
            {f.run && (
              <span>
                {t('facilitationRounds')}: <span className="text-[color:var(--fg-strong)]">{f.run.rounds}</span>
              </span>
            )}
            {f.initiators.length > 0 && (
              <span>
                {t('facilitationInitiator')}: <span className="font-mono">{f.initiators.join(', ')}</span>
              </span>
            )}
            {(f.participants ?? []).filter((p) => !p.isBot).length > 0 && (
              <span>
                {t('facilitationParticipants')}:{' '}
                {(f.participants ?? [])
                  .filter((p) => !p.isBot)
                  .map((p) => p.displayName)
                  .join(', ')}
              </span>
            )}
            {f.expiresAt && (
              <span>
                {t('facilitationExpires')}: {format.dateTime(new Date(f.expiresAt))}
              </span>
            )}
          </div>
          <div>
            <p className="mb-2 font-medium text-[color:var(--fg-strong)]">{t('facilitationTraceHeading')}</p>
            {trace ? (
              <ConductorRunTrace result={trace} />
            ) : traceError ? (
              <p className="text-[color:var(--danger,#e5484d)]">{t('facilitationTraceFailed')}</p>
            ) : f.run ? (
              <p className="text-[color:var(--fg-muted)]">{t('facilitationsLoading')}</p>
            ) : (
              <p className="text-[color:var(--fg-muted)]">{t('facilitationNoRun')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
