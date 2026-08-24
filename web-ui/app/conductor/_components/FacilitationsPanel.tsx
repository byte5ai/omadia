'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import {
  ApiError,
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
      setError(err instanceof ApiError ? t('facilitationsLoadFailed') : String(err));
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
        setError(err instanceof ApiError ? t('facilitationTerminateFailed') : String(err));
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
          {loading ? `${t('refreshButton')}…` : t('facilitationsEmpty')}
        </p>
      ) : (
        <ul className="grid gap-3">
          {rows.map((f) => {
            const tone = STATUS_TONE[f.run?.status ?? ''] ?? 'var(--fg-muted)';
            const humans = (f.participants ?? []).filter((p) => !p.isBot);
            return (
              <li key={f.workflowId} className="rounded-md border border-[color:var(--border)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    {f.run && (
                      <span
                        className="rounded-md px-2 py-0.5 font-mono text-[11px]"
                        style={{ color: tone, border: `1px solid ${tone}` }}
                      >
                        {f.run.status}
                      </span>
                    )}
                    <span className="truncate text-[14px] font-medium text-[color:var(--fg-strong)]">
                      {f.run?.goal ?? f.name}
                    </span>
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
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-[13px] text-[color:var(--fg-muted)] sm:grid-cols-2">
                  {f.conversation && (
                    <div>
                      <dt className="inline font-medium">{t('facilitationConversation')}: </dt>
                      <dd className="inline font-mono text-[12px]">
                        {f.conversation.channelType} · {f.conversation.conversationId}
                      </dd>
                    </div>
                  )}
                  {f.run?.definitionOfDone && (
                    <div className="sm:col-span-2">
                      <dt className="inline font-medium">{t('facilitationDod')}: </dt>
                      <dd className="inline">{f.run.definitionOfDone}</dd>
                    </div>
                  )}
                  {f.run && (
                    <div>
                      <dt className="inline font-medium">{t('facilitationRounds')}: </dt>
                      <dd className="inline">{f.run.rounds}</dd>
                    </div>
                  )}
                  {f.run?.lastVerdict && (
                    <div className="sm:col-span-2">
                      <dt className="inline font-medium">{t('facilitationLastVerdict')}: </dt>
                      <dd className="inline">
                        {f.run.lastVerdict.dodMet === true
                          ? t('facilitationDodMet')
                          : f.run.lastVerdict.dodMet === false
                            ? t('facilitationDodOpen')
                            : '—'}
                        {f.run.lastVerdict.summary ? ` — ${f.run.lastVerdict.summary}` : ''}
                      </dd>
                    </div>
                  )}
                  {humans.length > 0 && (
                    <div className="sm:col-span-2">
                      <dt className="inline font-medium">{t('facilitationParticipants')}: </dt>
                      <dd className="inline">
                        {humans.map((p) => p.displayName).join(', ')}
                        {f.participantsPartial ? ` ${t('facilitationRosterPartial')}` : ''}
                      </dd>
                    </div>
                  )}
                  {f.initiators.length > 0 && (
                    <div>
                      <dt className="inline font-medium">{t('facilitationInitiator')}: </dt>
                      <dd className="inline font-mono text-[12px]">{f.initiators.join(', ')}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline font-medium">{t('facilitationExpires')}: </dt>
                    <dd className="inline">{fmtTime(f.expiresAt, format)}</dd>
                  </div>
                </dl>
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
