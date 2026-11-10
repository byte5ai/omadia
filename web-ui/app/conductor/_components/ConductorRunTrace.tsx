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
    // #1699 — the executor has always recorded boolean qualifiers next to the
    // kind (`noHolder`, `timedOut`, `ticked`, `invalid`), and this function read
    // `kind`/`ref` only and dropped every one of them before render. They
    // corroborate the reason column, so they are kept.
    //
    // ONLY the `true` flags. String-valued keys are deliberately not rendered:
    // `operator_cancel` carries `requestedBy: <principal id>`
    // (`runExecutor.ts` finalizeCancelledWaitingRun), and printing whoever
    // pressed cancel into the trace table is an identity disclosure this view
    // never made and FR-030's "respecting existing redaction" does not invite.
    const flags = Object.entries(o)
      .filter(([key, value]) => value === true && key !== 'kind')
      .map(([key]) => key);
    const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    if (kind) return `${ref ? `${kind}:${ref}` : kind}${suffix}`;
  }
  return actor == null ? '—' : JSON.stringify(actor);
}

function fmtTime(iso: string | null, format: Formatter): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format.dateTime(d);
}

/**
 * #1699 — a step's wall-clock duration. Until migration 0013 every step row was
 * written with `started_at == ended_at` (both from the same transaction), so this
 * reads 0 ms for rows recorded by an older build — shown as such rather than
 * hidden, because a silent dash would look like missing data.
 *
 * The number goes through `useFormatter` and the unit through the catalog, so a
 * German locale reads "1,5 s" (web-ui/CLAUDE.md § String-handling 1 + 4). The
 * four hand-rolled `toFixed`/literal duration formatters elsewhere in this app
 * (RoutineRow, the routine-run page, BuilderChatPane, PreviewChatPane) have the
 * same defect — follow-up: one shared, locale-correct duration util.
 */
function useDurationLabel(): (
  startedAt: string | undefined,
  endedAt: string | null | undefined,
) => string {
  const t = useTranslations('conductor');
  const format = useFormatter();
  return (startedAt, endedAt) => {
    if (!startedAt || !endedAt) return '—';
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (Number.isNaN(ms) || ms < 0) return '—';
    if (ms < 1000) return t('durationMs', { value: format.number(ms) });
    if (ms < 60_000) {
      return t('durationSeconds', {
        value: format.number(ms / 1000, { maximumFractionDigits: 1 }),
      });
    }
    return t('durationMinutes', {
      min: format.number(Math.floor(ms / 60_000)),
      sec: format.number(Math.round((ms % 60_000) / 1000)),
    });
  };
}

/**
 * #1699 — a stored `ConductorRunErrorCode` (`middleware/src/conductor/runError.ts`)
 * is a message-catalog KEY, and the middleware is free to add one this build has
 * no translation for. `t.has` is how the rest of the app handles that
 * (`admin/builder/panels/InspectorPanel.tsx`, added there after unguarded call
 * sites rendered raw keys): the code shows as itself, never as a crash and never
 * as "no cause" — and no hand-maintained mirror of the vocabulary drifts here.
 */
function useRunErrorCodeLabel(): (code: string) => string {
  const t = useTranslations('conductor');
  return (code) => {
    const key = `runErrorCodes.${code}`;
    return t.has(key) ? t(key) : code.replace(/_/g, ' ');
  };
}

/**
 * The cause, as text. The CODE carries the meaning (translated); the stored
 * message is supporting detail, never the only signal — it is an engine sentence
 * or a redacted provider error, and it is already truncated server-side.
 */
function Reason({
  code,
  message,
  codeLabel,
  unknownLabel,
  emptyLabel,
}: {
  code: string | null | undefined;
  message: string | null | undefined;
  codeLabel: (code: string) => string;
  /** Shown where the code would go when there is a message but no code — the
   *  store drops a code outside this build's vocabulary and keeps the message,
   *  which must stay a detail rather than be promoted to the label. */
  unknownLabel: string;
  /** Shown when the row carries neither: "cause not recorded" for a failed run
   *  (pre-0013 rows), a plain dash for a step that simply has no cause. */
  emptyLabel: string;
}): React.JSX.Element {
  if (!code && !message) return <span>{emptyLabel}</span>;
  return (
    <span className="flex flex-col gap-0.5">
      <span>{code ? codeLabel(code) : unknownLabel}</span>
      {message ? (
        <span className="break-words text-[11px] text-[color:var(--fg-muted)]" title={message}>
          {message}
        </span>
      ) : null}
    </span>
  );
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
  const codeLabel = useRunErrorCodeLabel();
  const durationLabel = useDurationLabel();
  const runFailed = run.status === 'failed';
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
      {runFailed ? (
        <p className="text-[13px] text-[color:var(--fg-strong)]">
          <span className="text-[color:var(--fg-muted)]">{t('runReasonLabel')}: </span>
          {/* Pre-0013 rows carry neither, and `Reason` renders the same
              "cause not recorded" label for a code this build cannot read. */}
          <Reason
            code={run.errorCode}
            message={run.errorMessage}
            codeLabel={codeLabel}
            unknownLabel={t('runReasonUnknown')}
            emptyLabel={t('runReasonUnknown')}
          />
        </p>
      ) : null}
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
                <th scope="col" className="border-b border-[color:var(--border)] px-2 py-1">{t('colDuration')}</th>
                <th scope="col" className="border-b border-[color:var(--border)] px-2 py-1">{t('colReason')}</th>
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
                  <td className="border-b border-[color:var(--border)]/40 px-2 py-1">{durationLabel(s.startedAt, s.endedAt)}</td>
                  <td className="border-b border-[color:var(--border)]/40 px-2 py-1">
                    <Reason
                      code={s.errorCode}
                      message={s.errorMessage}
                      codeLabel={codeLabel}
                      unknownLabel={t('runReasonUnknown')}
                      emptyLabel="—"
                    />
                  </td>
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
  // #1699 — a run LIST that cannot say why a row is red is what this issue was
  // filed about, and the list carries the cause because the run row mirrors it.
  const codeLabel = useRunErrorCodeLabel();
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
  // Offered on the run-list rows too (#330 field report): the delete guard
  // demands cancelling active runs, so the button must be findable without
  // knowing to open a single trace first. Busy state is per run id — one
  // pending cancel must not lock every other row.
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const cancelRun = useCallback(
    async (runId: string) => {
      if (!confirm(t('cancelRunConfirm'))) return;
      setCancellingId(runId);
      setError(null);
      try {
        await cancelConductorRun(slug, runId);
        // Refresh whichever lens is open: the trace when this run is selected,
        // and always the list (status badge flips / row button disappears).
        if (selected?.run.id === runId) setSelected(await getConductorRun(slug, runId));
        await reload();
      } catch (err) {
        setError(err instanceof ApiError ? t('cancelRunFailed') : String(err));
      } finally {
        setCancellingId(null);
      }
    },
    [slug, t, reload, selected],
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
                busy={cancellingId === selected.run.id}
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
            <li key={r.id} className="flex items-center gap-2">
              {/* eslint-disable-next-line no-restricted-syntax -- full-width run-list row selector opening a trace, not a §4.2 CTA */}
              <button
                className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md border border-[color:var(--border)] px-3 py-2 text-left hover:bg-white/5"
                onClick={() => void openRun(r.id)}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <StatusBadge status={r.status} />
                  <span className="font-mono text-[12px] text-[color:var(--fg-muted)]">{r.triggerKind}</span>
                  {r.status === 'failed' ? (
                    <span
                      className="min-w-0 truncate text-[12px] text-[color:var(--fg-muted)]"
                      title={r.errorMessage ?? undefined}
                    >
                      {r.errorCode ? codeLabel(r.errorCode) : t('runReasonUnknown')}
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-[11px] text-[color:var(--fg-muted)]">{fmtTime(r.startedAt, format)}</span>
              </button>
              {/* #330 field report — the delete guard demands cancelling active
                  runs; the button has to be visible from the LIST, not hidden
                  inside a single trace. Sibling (not nested) button: the row
                  selector stays a plain button, valid HTML. */}
              {(r.status === 'running' || r.status === 'waiting') && (
                <Button
                  variant="danger"
                  busy={cancellingId === r.id}
                  busyLabel={t('cancelRunBusy')}
                  onClick={() => void cancelRun(r.id)}
                >
                  {t('cancelRunButton')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
