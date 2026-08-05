'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import type { DevJobUiPhase } from '@/app/_components/devjobs/DevJobPhaseRail';

import { getArtifactText, listJobArtifacts, type DevJobArtifactKind } from '../_lib/api';
import { PrettyArtifact } from './PrettyArtifact';

/**
 * Epic #470 — a completed phase's own recorded output (plan/questions/
 * bootstrap_report/review_verdict), shown once the live SSE log has nothing
 * left for it. The job detail page (`jobs/[id]/page.tsx`) fell back to a
 * permanently-empty `JobLogPane` for any phase the operator navigated back
 * to after it finished, because that pane is filtered from live-only state —
 * there was never a second source once the phase's own log scrolled away or
 * the operator reloaded the page. `GET /jobs/:id/artifacts` +
 * `GET /artifacts/:id` already existed and already served the gate's own
 * plan text (`GateInbox.tsx`'s `getArtifactText`); this reuses both for every
 * other phase instead of just the currently-open gate.
 */

/** Not every phase has a matching artifact kind (`implement`'s output is the
 *  diff, already linked from the PR stop; `gate`/`pr` render their own body). */
const PHASE_ARTIFACT_KIND: Partial<Record<DevJobUiPhase, DevJobArtifactKind>> = {
  analyze: 'analysis',
  bootstrap: 'bootstrap_report',
  plan: 'plan',
  clarify: 'questions',
  review: 'review_verdict',
};

type FetchState = { kind: 'loading' } | { kind: 'empty' } | { kind: 'error' } | { kind: 'ready'; text: string };
type PanelState = { kind: 'no-artifact-kind' } | FetchState;

/** Renders the given phase's own artifact when one exists; `null` when the
 *  phase has no artifact kind at all (caller falls back to the log pane) or
 *  none has been recorded yet (also a `JobLogPane` fallback — the phase may
 *  still be running). */
export function PhaseArtifactPanel({
  jobId,
  phase,
}: {
  jobId: string;
  phase: DevJobUiPhase;
}): React.ReactElement | null {
  const t = useTranslations('adminDevPlatform.detail');
  const kind = PHASE_ARTIFACT_KIND[phase];
  const [fetched, setFetched] = useState<FetchState>({ kind: 'loading' });
  // No artifact kind for this phase ⇒ no fetch ever happens — derive
  // 'no-artifact-kind' here rather than storing it, so the effect below never
  // needs a synchronous setState for that case (same idiom as GateInbox.tsx's
  // `planText`).
  const state: PanelState = kind ? fetched : { kind: 'no-artifact-kind' };

  useEffect(() => {
    if (!kind) return;
    let cancelled = false;
    setFetched({ kind: 'loading' });
    void listJobArtifacts(jobId).then(
      (res) => {
        if (cancelled) return;
        // Multiple retries/resumes can leave several artifacts of the same
        // kind (e.g. a retried bootstrap) — the most recent one is the phase's
        // actual last outcome.
        const latest = res.artifacts
          .filter((a) => a.kind === kind)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!latest) {
          setFetched({ kind: 'empty' });
          return;
        }
        void getArtifactText(latest.id).then(
          (text) => {
            if (!cancelled) setFetched({ kind: 'ready', text });
          },
          () => {
            if (!cancelled) setFetched({ kind: 'error' });
          },
        );
      },
      () => {
        if (!cancelled) setFetched({ kind: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [jobId, kind]);

  if (state.kind === 'no-artifact-kind' || state.kind === 'empty') return null;
  if (state.kind === 'loading') {
    return <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>;
  }
  if (state.kind === 'error') {
    return <p className="text-sm text-[color:var(--danger)]">{t('artifactError')}</p>;
  }
  return <PrettyArtifact text={state.text} />;
}
