'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  listConductorWorkflows,
  publishConductorWorkflow,
  startConductorRun,
  type ConductorRunResult,
  type ConductorWorkflow,
} from '@/app/_lib/api';

const EXAMPLE_GRAPH = `{
  "entryStepId": "greet",
  "steps": [
    {
      "id": "greet",
      "kind": "agent",
      "agentId": "fallback",
      "prompt": "Greet the team in one short, friendly sentence."
    }
  ],
  "transitions": [],
  "triggers": [{ "id": "tr", "kind": "manual" }]
}`;

interface ValidationError {
  code: string;
  message: string;
  nodeIds?: string[];
}

export default function ConductorPage(): React.JSX.Element {
  const t = useTranslations('conductor');

  const [workflows, setWorkflows] = useState<ConductorWorkflow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [graph, setGraph] = useState(EXAMPLE_GRAPH);
  const [enable, setEnable] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);

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

  const handlePublish = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setPublishing(true);
      setPublishError(null);
      setValidationErrors([]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(graph);
      } catch {
        setPublishError('Graph is not valid JSON');
        setPublishing(false);
        return;
      }
      try {
        await publishConductorWorkflow({ slug, name, graph: parsed, enable });
        setSlug('');
        setName('');
        await reload();
      } catch (err) {
        if (err instanceof ApiError) {
          try {
            const body = JSON.parse(err.body) as { errors?: ValidationError[] };
            if (Array.isArray(body.errors)) setValidationErrors(body.errors);
          } catch {
            /* body not JSON */
          }
          setPublishError(err.message);
        } else {
          setPublishError(String(err));
        }
      } finally {
        setPublishing(false);
      }
    },
    [graph, slug, name, enable, reload],
  );

  const handleRun = useCallback(
    async (wfSlug: string) => {
      setRunningSlug(wfSlug);
      setRunError(null);
      setRunResult(null);
      try {
        const res = await startConductorRun(wfSlug, {});
        setRunResult(res);
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
  const input =
    'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-[14px] text-[color:var(--fg-strong)]';

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      {/* Workflows list */}
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
      </section>

      {/* Run result */}
      {(runResult || runError) && (
        <section className="mb-10">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('lastRunHeading')}
          </h2>
          {runError && <p className="text-[14px] text-[color:var(--danger,#e5484d)]">{runError}</p>}
          {runResult && (
            <div className={card}>
              <div className="mb-3 text-[14px] text-[color:var(--fg-strong)]">
                {t('statusLabel')}: <span className="font-mono">{runResult.run.status}</span>
              </div>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                {t('stepPathHeading')}
              </h3>
              <table className="w-full text-left text-[13px]">
                <thead className="text-[color:var(--fg-muted)]">
                  <tr>
                    <th className="py-1 pr-3">{t('colSeq')}</th>
                    <th className="py-1 pr-3">{t('colStep')}</th>
                    <th className="py-1 pr-3">{t('colPostcondition')}</th>
                    <th className="py-1">{t('colTransition')}</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {runResult.steps.map((s) => (
                    <tr key={s.id} className="border-t border-[color:var(--border)]">
                      <td className="py-1 pr-3">{s.seq}</td>
                      <td className="py-1 pr-3">{s.stepId}</td>
                      <td className="py-1 pr-3">{s.postconditionOutcome ?? '—'}</td>
                      <td className="py-1">{s.transitionTaken ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 className="mb-2 mt-4 text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                {t('resultContext')}
              </h3>
              <pre className="overflow-x-auto rounded-md bg-black/20 p-3 text-[12px] text-[color:var(--fg-strong)]">
                {JSON.stringify(runResult.run.context, null, 2)}
              </pre>
            </div>
          )}
        </section>
      )}

      {/* Publish form */}
      <section>
        <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('publishHeading')}
        </h2>
        <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('publishHint')}</p>
        <form onSubmit={handlePublish} className={`${card} grid gap-4`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-[13px] text-[color:var(--fg-muted)]">
              {t('slugLabel')}
              <input
                className={input}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="release-signoff"
                required
              />
            </label>
            <label className="grid gap-1 text-[13px] text-[color:var(--fg-muted)]">
              {t('nameLabel')}
              <input
                className={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Release sign-off"
                required
              />
            </label>
          </div>
          <label className="grid gap-1 text-[13px] text-[color:var(--fg-muted)]">
            {t('graphLabel')}
            <textarea
              className={`${input} min-h-[220px] font-mono text-[12px]`}
              value={graph}
              onChange={(e) => setGraph(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[color:var(--fg-muted)]">
            <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
            {t('enableLabel')}
          </label>

          {publishError && <p className="text-[14px] text-[color:var(--danger,#e5484d)]">{publishError}</p>}
          {validationErrors.length > 0 && (
            <div className="rounded-md border border-[color:var(--danger,#e5484d)] p-3">
              <div className="mb-1 text-[13px] font-semibold text-[color:var(--danger,#e5484d)]">
                {t('validationHeading')}
              </div>
              <ul className="list-inside list-disc text-[13px] text-[color:var(--fg-muted)]">
                {validationErrors.map((v, i) => (
                  <li key={i}>
                    <span className="font-mono">{v.code}</span>: {v.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <Button type="submit" variant="primary" busy={publishing} disabled={publishing}>
              {publishing ? t('publishing') : t('publishButton')}
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
