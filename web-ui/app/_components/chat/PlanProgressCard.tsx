'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  type PlanOverlay,
  planStepColor,
} from '../../graph/_components/graphTypes';

/**
 * #133 (E8) — inline plan-DAG progress for a single chat turn.
 *
 * The orchestrator drives the turn; the plan-runner plugin persists a parallel
 * Plan + PlanStep DAG (keyed by an internal turn UUID) and, on `onAfterTurn`,
 * back-links it to the persisted Turn node via `PLAN_OF` + `plan.props.turnId`.
 * The chat only knows the persisted Turn node id (`message.turnId`), so we
 * resolve the plan by scanning the scope's plans for `props.turnId === turnId`.
 *
 * Renders nothing when the turn produced no plan (the common case — only
 * multi-step turns the gate flagged get one).
 */

type PlanEntry = PlanOverlay['plans'][number];

interface Props {
  /** Session scope (== chat tab id == orchestrator scope). */
  scope: string;
  /** Persisted Turn node external id (`turn:<scope>:<time>`). */
  turnId: string;
  /** When true (turn just finished), retry briefly: the `PLAN_OF` back-link is
   *  written in `onAfterTurn`, a moment after the `done` event arrives. */
  recent: boolean;
}

// Module-level per-scope cache so the N message cards in a conversation share a
// single in-flight request instead of each hitting the endpoint. Short TTL so a
// forced refetch (retry for a fresh turn) actually re-reads the backend.
const TTL_MS = 4000;
const cache = new Map<string, { ts: number; promise: Promise<PlanEntry[]> }>();

async function fetchPlansForScope(
  scope: string,
  force: boolean,
): Promise<PlanEntry[]> {
  const now = Date.now();
  const hit = cache.get(scope);
  if (!force && hit && now - hit.ts < TTL_MS) return hit.promise;
  const promise = (async (): Promise<PlanEntry[]> => {
    try {
      const res = await fetch(
        `/bot-api/dev/graph/plans?scope=${encodeURIComponent(scope)}`,
      );
      if (!res.ok) return [];
      const body = (await res.json()) as PlanOverlay;
      return body.plans ?? [];
    } catch {
      return [];
    }
  })();
  cache.set(scope, { ts: now, promise });
  return promise;
}

const MAX_RETRIES = 4;

export function PlanProgressCard({
  scope,
  turnId,
  recent,
}: Props): React.ReactElement | null {
  const t = useTranslations('planCard');
  const [entry, setEntry] = useState<PlanEntry | null>(null);
  const attempts = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    attempts.current = 0;

    const attempt = async (force: boolean): Promise<void> => {
      const plans = await fetchPlansForScope(scope, force);
      if (cancelled) return;
      const found =
        plans.find((p) => String(p.plan.props['turnId'] ?? '') === turnId) ??
        null;
      if (found) {
        setEntry(found);
        return;
      }
      if (recent && attempts.current < MAX_RETRIES) {
        attempts.current += 1;
        timer = setTimeout(() => {
          void attempt(true);
        }, 1500);
      }
    };
    void attempt(false);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [scope, turnId, recent]);

  if (!entry) return null;

  const steps = [...entry.steps].sort(
    (a, b) => Number(a.props['order'] ?? 0) - Number(b.props['order'] ?? 0),
  );
  if (steps.length === 0) return null;
  const doneCount = steps.filter((s) => s.props['status'] === 'done').length;

  const statusLabel = (status: unknown): string => {
    switch (status) {
      case 'done':
        return t('statusDone');
      case 'in_progress':
        return t('statusInProgress');
      case 'failed':
        return t('statusFailed');
      case 'skipped':
        return t('statusSkipped');
      default:
        return t('statusPending');
    }
  };

  return (
    <details className="mb-2 rounded-md border border-violet-200 bg-violet-50/50 text-xs dark:border-violet-900/50 dark:bg-violet-950/20">
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 font-medium text-violet-700 dark:text-violet-300">
        <span aria-hidden>🗺</span>
        <span>{t('heading')}</span>
        <span className="font-normal text-violet-500 dark:text-violet-400">
          {t('summary', { done: doneCount, total: steps.length })}
        </span>
      </summary>
      <ol className="flex flex-col gap-1 px-2.5 pb-2 pt-0.5">
        {steps.map((s, i) => {
          const status = s.props['status'];
          const goal = String(s.props['goal'] ?? '');
          return (
            <li key={s.id} className="flex items-start gap-2">
              <span
                className="mt-[3px] h-2 w-2 flex-shrink-0 rounded-full"
                style={{ backgroundColor: planStepColor(status) }}
                title={statusLabel(status)}
                aria-hidden
              />
              <span className="text-neutral-700 dark:text-neutral-300">
                <span className="text-neutral-400 dark:text-neutral-500">
                  {i + 1}.
                </span>{' '}
                {goal}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {statusLabel(status)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
