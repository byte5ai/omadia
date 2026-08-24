'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import {
  listFacilitations,
  terminateFacilitation,
  type FacilitationOverview,
} from '@/app/_lib/api';

const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

const STATUS_TONE: Record<string, string> = {
  running: 'var(--accent,#3b82f6)',
  waiting: 'var(--warning,#f5a623)',
  completed: 'var(--success,#30a46c)',
  failed: 'var(--danger,#e5484d)',
  cancelled: 'var(--fg-muted)',
};

/** DoD text usually arrives as one flat "1. ... 2. ..." sentence from chat —
 *  split it back into list items for reading. Deterministic string handling
 *  only; anything without the numbering pattern renders as plain text. */
function splitDod(text: string): string[] | null {
  const parts = text.split(/(?=(?:^|\s)\d{1,2}\.\s)/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map((part) => part.replace(/^\d{1,2}\.\s*/, ''));
}

function fmtTime(iso: string | null, format: ReturnType<typeof useFormatter>): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format.dateTime(d);
}

/**
 * #330 round 4 — the operator lens over LIVE facilitations. Ephemeral
 * workflows are hidden from the library by design, which made running
 * facilitations invisible: two instances ended up moderating the same
 * meeting. This panel shows every not-yet-reaped facilitation with its
 * durable state (goal/DoD from the run context, assess rounds, latest
 * verdict), the conversation, participants (roster, best-effort) and the
 * initiator — plus ONE destructive action: terminate (cancel runs + dispose
 * of binding/role/scaffold).
 */
export function FacilitationsPanel(): React.JSX.Element {
  const t = useTranslations('conductor');
  const format = useFormatter();
  const [rows, setRows] = useState<FacilitationOverview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [terminating, setTerminating] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { facilitations } = await listFacilitations();
      setRows(facilitations);
    } catch (err) {
      void err;
      setError(t('facilitationsLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const terminate = useCallback(
    async (workflowId: string) => {
      setTerminating(workflowId);
      setError(null);
      try {
        await terminateFacilitation(workflowId);
        await reload();
      } catch (err) {
        void err;
      setError(t('facilitationTerminateFailed'));
      } finally {
        setTerminating(null);
      }
    },
    [reload, t],
  );

  return (
    <section className={card}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[color:var(--fg-strong)]">{t('facilitationsHeading')}</h2>
        <Button variant="ghost" onClick={() => void reload()}>
          {t('refreshButton')}
        </Button>
      </div>
      {error && <p className="mb-3 text-[14px] text-[color:var(--danger,#e5484d)]">{error}</p>}
      {rows.length === 0 ? (
        <p className="text-[13px] text-[color:var(--fg-muted)]">
          {loading ? t('facilitationsLoading') : t('facilitationsEmpty')}
        </p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((f) => {
            const tone = STATUS_TONE[f.run?.status ?? ''] ?? 'var(--fg-muted)';
            const humans = (f.participants ?? []).filter((p) => !p.isBot);
            return (
              <li key={f.workflowId} className="rounded-md border border-[color:var(--border)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {f.run && (
                        <span
                          className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px]"
                          style={{ color: tone, border: `1px solid ${tone}` }}
                        >
                          {f.run.status}
                        </span>
                      )}
                      {f.conversation && (
                        <span className="truncate font-mono text-[11px] text-[color:var(--fg-muted)]">
                          {f.conversation.channelType} · {f.conversation.conversationId}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 max-w-[70ch] text-[14px] font-medium leading-snug text-[color:var(--fg-strong)]">
                      {f.run?.goal ?? f.name}
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    busy={terminating === f.workflowId}
                    busyLabel={t('facilitationTerminateBusy')}
                    onClick={() => setConfirmId(f.workflowId)}
                  >
                    {t('facilitationTerminateButton')}
                  </Button>
                </div>
                {f.incomplete && (
                  <p className="mt-2 text-[12px] text-[color:var(--warning,#f5a623)]">{t('facilitationIncomplete')}</p>
                )}
                {f.run?.lastVerdict && (
                  <div className="mt-3 rounded-md border border-[color:var(--border)] bg-black/10 px-3 py-2 text-[13px]">
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
                {f.run?.definitionOfDone && (
                  <div className="mt-3 max-w-[80ch] text-[13px] text-[color:var(--fg-muted)]">
                    <p className="mb-1 font-medium text-[color:var(--fg-strong)]">{t('facilitationDod')}</p>
                    {(() => {
                      const items = splitDod(f.run.definitionOfDone);
                      return items ? (
                        <ol className="list-decimal space-y-0.5 pl-5">
                          {items.map((item, idx) => (
                            <li key={idx}>{item}</li>
                          ))}
                        </ol>
                      ) : (
                        <p>{f.run.definitionOfDone}</p>
                      );
                    })()}
                  </div>
                )}
                {humans.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[13px]">
                    <span className="font-medium text-[color:var(--fg-strong)]">{t('facilitationParticipants')}:</span>
                    {humans.map((p) => (
                      <span
                        key={p.displayName}
                        className="rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[12px] text-[color:var(--fg-muted)]"
                      >
                        {p.displayName}
                      </span>
                    ))}
                    {f.participantsPartial && (
                      <span className="text-[12px] text-[color:var(--fg-muted)]">{t('facilitationRosterPartial')}</span>
                    )}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-[color:var(--border)]/50 pt-2 text-[12px] text-[color:var(--fg-muted)]">
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
                  <span>
                    {t('facilitationExpires')}: {fmtTime(f.expiresAt, format)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirmId !== null}
        title={t('facilitationTerminateConfirmTitle')}
        body={t('facilitationTerminateConfirmBody')}
        confirmLabel={t('facilitationTerminateButton')}
        cancelLabel={t('deleteCancelButton')}
        tone="danger"
        onConfirm={() => {
          const id = confirmId;
          setConfirmId(null);
          if (id) void terminate(id);
        }}
        onCancel={() => setConfirmId(null)}
      />
    </section>
  );
}
