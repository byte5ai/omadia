'use client';

import { useCallback, useEffect, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

type Formatter = ReturnType<typeof useFormatter>;

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '@/app/_lib/api';
import {
  DEV_ARTIFACT_PATH,
  getArtifactText,
  listWaitingGates,
  resolveGate,
  type DevGateAnswer,
  type DevGateView,
} from '../_lib/api';
import { PrettyArtifact } from './PrettyArtifact';

/**
 * Epic #470 W2 — the operator gate inbox (UI spec §5). Lists every job parked at
 * `await_human`: its job id, the plan under review (a link to the plan artifact
 * plus its sha256), the agent's clarifying questions, the deadline, and the
 * holders currently authorized to resolve it. Each gate has an approve/reject
 * action — approve carries one answer field per question plus an optional note;
 * reject carries the note.
 *
 * The framing is load-bearing: plan approval here is ADVISORY. The authoritative
 * safety control is the diff gate (W3) that reviews the actual patch before the
 * PR — this inbox only lets a plan proceed to implementation. The banner says so.
 *
 * Failure handling (spec §5 authorization): a 403 means the caller is not a
 * holder of this gate (a moved role baton re-targeted it) — we say so in place,
 * without mutating anything. A 409 means the gate is no longer pending (someone
 * else resolved it, or it expired) — we surface it and refresh the list so the
 * stale card drops out. No spinner (Lume §7.3): buttons carry `busy`.
 */

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; gates: DevGateView[] }
  | { kind: 'error'; code: 'unauthorized' | 'generic' };

export function GateInbox(): React.ReactElement {
  const t = useTranslations('adminDevPlatform.gates');
  const [state, setState] = useState<ListState>({ kind: 'loading' });

  const load = useCallback(() => {
    void listWaitingGates().then(
      (res) => setState({ kind: 'ready', gates: res.gates }),
      (err) =>
        setState({
          kind: 'error',
          code: err instanceof ApiError && (err.status === 401 || err.status === 403) ? 'unauthorized' : 'generic',
        }),
    );
  }, []);

  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border-l-2 border-l-[color:var(--warning)] border-y border-r border-[color:var(--border)] px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--warning)]">
          {t('advisoryHeading')}
        </h2>
        <p className="mt-1 max-w-2xl text-xs text-[color:var(--fg)]">{t('advisoryBody')}</p>
      </div>

      {state.kind === 'loading' ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        state.code === 'unauthorized' ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('unauthorized')}</p>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-[color:var(--danger)]">{t('loadError')}</span>
            <Button size="sm" variant="secondary" onClick={load}>
              {t('retry')}
            </Button>
          </div>
        )
      ) : state.gates.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        state.gates.map((gate) => <GateCard key={gate.id} gate={gate} onResolved={load} />)
      )}
    </div>
  );
}

type ResolveState =
  | { kind: 'idle' }
  | { kind: 'notHolder' }
  | { kind: 'conflict' }
  | { kind: 'error' };

type PlanTextState = { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'error' } | { kind: 'none' };

/** `compact`: drop the deadline/job-id header (the job-detail page already
 *  shows both) and the outer bordered card — used to embed the gate inline in
 *  the job's own phase flow instead of only in the standalone gate inbox. */
export function GateCard({
  gate,
  onResolved,
  compact = false,
}: {
  gate: DevGateView;
  onResolved: () => void;
  compact?: boolean;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.gates');
  const format = useFormatter();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [resolveState, setResolveState] = useState<ResolveState>({ kind: 'idle' });
  const [fetchedPlanText, setFetchedPlanText] = useState<PlanTextState>({ kind: 'loading' });
  // No artifact ⇒ no fetch ever happens — derive 'none' rather than storing it,
  // so the effect below never needs a synchronous setState in its early return.
  const planText: PlanTextState = gate.planArtifactId ? fetchedPlanText : { kind: 'none' };

  useEffect(() => {
    if (!gate.planArtifactId) return;
    let cancelled = false;
    setFetchedPlanText({ kind: 'loading' });
    void getArtifactText(gate.planArtifactId).then(
      (text) => {
        if (!cancelled) setFetchedPlanText({ kind: 'ready', text });
      },
      () => {
        if (!cancelled) setFetchedPlanText({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gate.planArtifactId]);

  const resolve = useCallback(
    (approved: boolean) => {
      setBusy(approved ? 'approve' : 'reject');
      setResolveState({ kind: 'idle' });
      void (async () => {
        try {
          const collected: DevGateAnswer[] = gate.questions
            .map((q) => ({ questionId: q.id, text: (answers[q.id] ?? '').trim() }))
            .filter((a) => a.text.length > 0);
          await resolveGate(gate.id, {
            approved,
            ...(approved && collected.length > 0 ? { answers: collected } : {}),
            ...(note.trim().length > 0 ? { note: note.trim() } : {}),
          });
          onResolved();
        } catch (err) {
          setBusy(null);
          if (err instanceof ApiError && err.status === 403) {
            setResolveState({ kind: 'notHolder' });
            return;
          }
          if (err instanceof ApiError && err.status === 409) {
            setResolveState({ kind: 'conflict' });
            // The gate is no longer pending — refresh so this card drops out.
            onResolved();
            return;
          }
          setResolveState({ kind: 'error' });
        }
      })();
    },
    [answers, gate.id, gate.questions, note, onResolved],
  );

  return (
    <section
      className={
        compact ? '' : 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4'
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {compact ? null : (
          <div className="text-sm text-[color:var(--fg-strong)]">
            {t('job')} <span className="font-mono text-xs text-[color:var(--fg)]">{gate.jobId}</span>
          </div>
        )}
        <div className="text-xs text-[color:var(--fg-subtle)]">
          {gate.deadlineAt ? t('deadline', { at: formatTs(gate.deadlineAt, format) }) : t('noDeadline')}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-[color:var(--fg-subtle)]">{t('holders')}</dt>
        <dd className="font-mono text-[11px] text-[color:var(--fg-muted)]">
          {gate.resolvedHolders.length > 0 ? gate.resolvedHolders.join(', ') : t('noHolders')}
        </dd>
      </dl>

      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--fg-muted)]">
            {t('plan')}
          </h3>
          <div className="flex items-center gap-2">
            {gate.planSha256 ? (
              <span className="font-mono text-[11px] text-[color:var(--fg-subtle)]">
                {gate.planSha256.slice(0, 12)}
              </span>
            ) : null}
            {gate.planArtifactId ? (
              <a
                href={DEV_ARTIFACT_PATH(gate.planArtifactId)}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-[color:var(--accent)] underline"
              >
                {t('viewPlan')}
              </a>
            ) : null}
          </div>
        </div>
        {planText.kind === 'none' ? (
          <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('noPlan')}</p>
        ) : planText.kind === 'loading' ? (
          <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('planLoading')}</p>
        ) : planText.kind === 'error' ? (
          <p className="mt-1 text-xs text-[color:var(--danger)]">{t('planLoadError')}</p>
        ) : (
          <div className="mt-1 max-h-[50vh] overflow-y-auto">
            <PrettyArtifact text={planText.text} />
          </div>
        )}
      </div>

      {gate.questions.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--fg-muted)]">
            {t('questions')}
          </h3>
          {gate.questions.map((q) => (
            <label key={q.id} className="flex flex-col gap-1 text-xs">
              <span className="text-[color:var(--fg)]">{q.text}</span>
              <textarea
                className="min-h-[56px] rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                placeholder={t('answerPlaceholder')}
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-xs text-[color:var(--fg-muted)]">{t('noQuestions')}</p>
      )}

      <label className="mt-4 flex flex-col gap-1 text-xs">
        <span className="text-[color:var(--fg-muted)]">{t('noteLabel')}</span>
        <input
          className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('notePlaceholder')}
          autoComplete="off"
        />
      </label>

      {resolveState.kind === 'notHolder' ? (
        <p className="mt-3 text-sm text-[color:var(--danger)]">{t('notHolder')}</p>
      ) : null}
      {resolveState.kind === 'conflict' ? (
        <p className="mt-3 text-sm text-[color:var(--warning)]">{t('alreadyResolved')}</p>
      ) : null}
      {resolveState.kind === 'error' ? (
        <p className="mt-3 text-sm text-[color:var(--danger)]">{t('resolveError')}</p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="danger"
          size="sm"
          busy={busy === 'reject'}
          busyLabel={t('rejecting')}
          disabled={busy !== null}
          onClick={() => resolve(false)}
        >
          {t('reject')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          busy={busy === 'approve'}
          busyLabel={t('approving')}
          disabled={busy !== null}
          onClick={() => resolve(true)}
        >
          {t('approve')}
        </Button>
      </div>
    </section>
  );
}

/** ISO timestamp → locale string; falls back to the raw value if unparseable. */
function formatTs(iso: string, format: Formatter): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : format.dateTime(d);
}
