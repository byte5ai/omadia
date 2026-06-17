'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  getConductorRun,
  listConductorWorkflows,
  startConductorRun,
  type ConductorRunResult,
  type ConductorWorkflow,
} from '@/app/_lib/api';

import { ConductorCanvas } from './_components/ConductorCanvas';

export default function ConductorPage(): React.JSX.Element {
  const t = useTranslations('conductor');

  const [workflows, setWorkflows] = useState<ConductorWorkflow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningSlug, setRunningSlug] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ConductorRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await listConductorWorkflows();
      setWorkflows(res.workflows);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleRun = useCallback(
    async (wfSlug: string) => {
      setRunningSlug(wfSlug);
      setRunError(null);
      setRunResult(null);
      try {
        const started = await startConductorRun(wfSlug, {});
        setRunResult(started);
        const runId = started.run.id;
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, 2000));
          const latest = await getConductorRun(wfSlug, runId);
          setRunResult(latest);
          if (latest.run.status !== 'running') break;
        }
        await reload();
      } catch (err) {
        setRunError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setRunningSlug(null);
      }
    },
    [reload],
  );

  const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">{t('intro')}</p>
      </header>

      {/* Workflows list with quick-run */}
      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('workflowsHeading')}
          </h2>
          <Button variant="ghost" onClick={() => void reload()}>
            {t('refreshButton')}
          </Button>
        </div>
        {loadError && <p className="mb-3 text-[14px] text-[color:var(--danger,#e5484d)]">{loadError}</p>}
        {workflows.length === 0 ? (
          <p className="text-[14px] text-[color:var(--fg-muted)]">{t('noWorkflows')}</p>
        ) : (
          <ul className="grid gap-3">
            {workflows.map((wf) => (
              <li key={wf.id} className={`${card} flex items-center justify-between gap-4`}>
                <div>
                  <div className="text-[15px] font-medium text-[color:var(--fg-strong)]">{wf.name}</div>
                  <div className="font-mono text-[12px] text-[color:var(--fg-muted)]">
                    {wf.slug} · {t('statusLabel')}: {wf.status}
                  </div>
                </div>
                <Button
                  variant="primary"
                  busy={runningSlug === wf.slug}
                  disabled={runningSlug !== null}
                  onClick={() => void handleRun(wf.slug)}
                >
                  {runningSlug === wf.slug ? t('running') : t('runButton')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {runError && <p className="mt-3 text-[14px] text-[color:var(--danger,#e5484d)]">{runError}</p>}
        {runResult && (
          <div className={`${card} mt-4`}>
            <div className="mb-2 text-[14px] text-[color:var(--fg-strong)]">
              {t('lastRunHeading')} · {t('statusLabel')}: <span className="font-mono">{runResult.run.status}</span>
            </div>
            <pre className="overflow-x-auto rounded-md bg-black/20 p-3 text-[12px] text-[color:var(--fg-strong)]">
              {JSON.stringify(runResult.run.context, null, 2)}
            </pre>
          </div>
        )}
      </section>

      {/* Visual designer */}
      <section>
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('designerHeading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('designerHint')}</p>
        <ConductorCanvas workflows={workflows} onSaved={() => void reload()} />
      </section>
    </main>
  );
}
