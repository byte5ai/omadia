'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

type Formatter = ReturnType<typeof useFormatter>;

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  cancelConductorRun,
  getConductorRun,
  listConductorRuns,
  type ConductorRun,
  type ConductorRunResult,
  type ConductorRunStep,
} from '@/app/_lib/api';

const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

const STATUS_TONE: Record<string, string> = {
  completed: 'var(--success,#30a46c)',
  running: 'var(--accent,#3b82f6)',
  waiting: 'var(--warning,#f5a623)',
  failed: 'var(--danger,#e5484d)',
  // #759 — operator-terminated: neutral, neither success nor failure.
  cancelled: 'var(--fg-muted)',
};

/** A step's actor is free-form JSON (e.g. {kind:'agent',ref:'fallback'}); render it compactly. */
function actorLabel(actor: unknown): string {
  if (actor && typeof actor === 'object' && !Array.isArray(actor)) {
    const o = actor as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind : null;
    const ref =
      (typeof o.ref === 'string' && o.ref) ||
      (typeof o.resolvedUserId === 'string' && o.resolvedUserId) ||
      null;
    if (kind) return ref ? `${kind}:${ref}` : kind;
  }
  return actor == null ? '—' : JSON.stringify(actor);
}

function fmtTime(iso: string | null, format: Formatter): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format.dateTime(d);
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const tone = STATUS_TONE[status] ?? 'var(--fg-muted)';
  return (
    <span
      className="rounded-md px-2 py-0.5 font-mono text-[11px]"
      style={{ color: tone, border: `1px solid ${tone}` }}
    >
      {status}
    </span>
  );
}

/**
 * Renders one run's ordered step trace — the US9 audit surface over conductor_run_steps:
 * trigger, status, timing, and per-step actor / postcondition outcome / transition taken.
 */
export function ConductorRunTrace({ result }: { result: ConductorRunResult }): React.JSX.Element {
  const t = useTranslations('conductor');
  const format = useFormatter();
  const { run, steps } = result;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[color:var(--fg-muted)]">
        <StatusBadge status={run.status} />
        <span>
          {t('runTriggerLabel')}: <span className="font-mono">{run.triggerKind}</span>
        </span>
        <span>
          {t('startedLabel')}: {fmtTime(run.startedAt, format)}
        </span>
        <span>
          {t('endedLabel')}: {fmtTime(run.endedAt, format)}
        </span>
      </div>
      {steps.length === 0 ? (
        <p className="text-[13px] text-[color:var(--fg-muted)]">{t('noSteps')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="text-[color:var(--fg-muted)]">
                <th scope="col" className="border-b border-[color:var(--border)] px-2 py-1">{t('colSeq')}</th>
                <th scope="col" className="border-b border-[color:var(--border)] px-2 py-1">{t('colStep')}</th>
                <th scope="col" className="border-b border-[color:var(--border)] px-2 py-1">{t('colActor')}</th>
                <th scope="col" className="border-b border-[color:var(--border)] px-2 py-1">{t('colPostcondition')}</th>
                <th scope="col" className="border-b border-[color:var(--border)] px-2 py-1">{t('colTransition')}</th>
              </tr>
            </thead>
            <tbody className="font-mono text-[color:var(--fg-strong)]">
              {steps.map((s: ConductorRunStep) => (
                <tr key={s.id}>
                  <td className="border-b border-[color:var(--border)]/40 px-2 py-1">{s.seq}</td>
                  <td className="border-b border-[color:var(--border)]/40 px-2 py-1">{s.stepId}</td>
                  <td className="border-b border-[color:var(--border)]/40 px-2 py-1">{actorLabel(s.actor)}</td>
                  <td className="border-b border-[color:var(--border)]/40 px-2 py-1">{s.postconditionOutcome ?? '—'}</td>
                  <td className="border-b border-[color:var(--border)]/40 px-2 py-1">{s.transitionTaken ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-[12px] text-[color:var(--fg-muted)]">{t('resultContext')}</summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-black/20 p-3 text-[12px] text-[color:var(--fg-strong)]">
          {JSON.stringify(run.context, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * Run-history audit panel for a workflow (US9): lists recent runs and opens any run's full
 * trace. The data already lives in conductor_runs / conductor_run_steps — this is the operator
 * lens onto it (and the way to observe the resume worker re-driving an orphaned run).
 */
export function ConductorRunHistory({ slug, onClose }: { slug: string; onClose: () => void }): React.JSX.Element {
  const t = useTranslations('conductor');
  const format = useFormatter();
  const [runs, setRuns] = useState<ConductorRun[]>([]);
  const [selected, setSelected] = useState<ConductorRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { runs: list } = await listConductorRuns(slug);
      setRuns(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset + fetch-on-mount loader
    setSelected(null);
    void reload();
  }, [reload]);

  const openRun = useCallback(
    async (runId: string) => {
      setError(null);
      try {
        setSelected(await getConductorRun(slug, runId));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [slug],
  );

  // #759 — operator cancel. 'waiting' ends immediately; 'running' shows the
  // pending hint until the driver honours the flag at the next step boundary.
  const [cancelling, setCancelling] = useState(false);
  const cancelRun = useCallback(
    async (runId: string) => {
      if (!confirm(t('cancelRunConfirm'))) return;
      setCancelling(true);
      setError(null);
      try {
        await cancelConductorRun(slug, runId);
        setSelected(await getConductorRun(slug, runId));
        await reload();
      } catch (err) {
        setError(err instanceof ApiError ? t('cancelRunFailed') : String(err));
      } finally {
        setCancelling(false);
      }
    },
    [slug, t, reload],
  );

  return (
    <div className={`${card} mt-4`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {t('historyHeading')} · <span className="font-mono text-[12px] text-[color:var(--fg-muted)]">{slug}</span>
        </h3>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void reload()}>
            {t('refreshButton')}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t('closeButton')}
          </Button>
        </div>
      </div>
      {error && <p className="mb-3 text-[14px] text-[color:var(--danger,#e5484d)]">{error}</p>}
      {selected ? (
        <div>
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setSelected(null)}>
              ← {t('backToRuns')}
            </Button>
            {(selected.run.status === 'running' || selected.run.status === 'waiting') && (
              <Button
                variant="danger"
                busy={cancelling}
                busyLabel={t('cancelRunBusy')}
                onClick={() => void cancelRun(selected.run.id)}
              >
                {t('cancelRunButton')}
              </Button>
            )}
          </div>
          {(selected.run.status === 'running' || selected.run.status === 'waiting') &&
          selected.run.cancelRequestedAt ? (
            <p className="mt-2 text-[13px] text-[color:var(--fg-muted)]">{t('cancelPendingHint')}</p>
          ) : null}
          <div className="mt-3">
            <ConductorRunTrace result={selected} />
          </div>
        </div>
      ) : runs.length === 0 ? (
        <p className="text-[13px] text-[color:var(--fg-muted)]">{loading ? `${t('refreshButton')}…` : t('noRuns')}</p>
      ) : (
        <ul className="grid gap-2">
          {runs.map((r) => (
            <li key={r.id}>
              {/* eslint-disable-next-line no-restricted-syntax -- full-width run-list row selector opening a trace, not a §4.2 CTA */}
              <button
                className="flex w-full items-center justify-between gap-3 rounded-md border border-[color:var(--border)] px-3 py-2 text-left hover:bg-white/5"
                onClick={() => void openRun(r.id)}
              >
                <span className="flex items-center gap-3">
                  <StatusBadge status={r.status} />
                  <span className="font-mono text-[12px] text-[color:var(--fg-muted)]">{r.triggerKind}</span>
                </span>
                <span className="font-mono text-[11px] text-[color:var(--fg-muted)]">{fmtTime(r.startedAt, format)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
