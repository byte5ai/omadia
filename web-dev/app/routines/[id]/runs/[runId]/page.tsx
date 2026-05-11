import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Markdown } from '../../../../_components/Markdown';
import {
  ApiError,
  getRoutineRun,
  type RoutineRunDetailDto,
} from '../../../../_lib/api';
import { RunTraceViewer } from '../../../_components/RunTraceViewer';

interface RouteParams {
  id: string;
  runId: string;
}

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Routine Run · Omadia',
};

export default async function RoutineRunDetailPage({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<React.ReactElement> {
  const { id, runId } = await params;
  let run: RoutineRunDetailDto | null = null;
  let loadError: string | null = null;
  try {
    const resp = await getRoutineRun(id, runId);
    run = resp.run;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    loadError =
      err instanceof Error ? err.message : 'Run-Detail nicht erreichbar.';
  }

  return (
    <main className="mx-auto w-full max-w-[1280px] px-6 py-12 lg:px-10 lg:py-16">
      <nav className="text-[12px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        <Link href="/routines" className="hover:text-[color:var(--accent)]">
          Routinen
        </Link>
        <span className="px-2">/</span>
        <Link
          href={`/routines#${id}`}
          className="font-mono text-[11px] hover:text-[color:var(--accent)]"
        >
          {id}
        </Link>
        <span className="px-2">/</span>
        <span className="font-mono text-[11px] text-[color:var(--fg-muted)]">
          run {runId.slice(0, 8)}
        </span>
      </nav>

      {loadError ? (
        <div className="mt-8 rounded-[18px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-6 text-sm text-[color:var(--danger)]">
          <div className="font-semibold">Run nicht erreichbar</div>
          <div className="mt-2 font-mono text-xs">{loadError}</div>
        </div>
      ) : run ? (
        <RunDetail run={run} />
      ) : null}
    </main>
  );
}

function RunDetail({ run }: { run: RoutineRunDetailDto }): React.ReactElement {
  return (
    <>
      <header className="mt-6 rounded-[22px] border border-[color:var(--divider)] bg-[color:var(--surface)] p-6 lg:p-8">
        <h1 className="font-display text-[clamp(1.75rem,3vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Run · {formatDate(run.startedAt)}
        </h1>
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-[12px] sm:grid-cols-4">
          <Field label="Trigger" value={triggerLabel(run.trigger)} mono />
          <Field
            label="Status"
            value={run.status}
            tone={
              run.status === 'ok'
                ? 'ok'
                : run.status === 'error'
                  ? 'danger'
                  : 'warn'
            }
            mono
          />
          <Field label="Dauer" value={formatDuration(run.durationMs)} mono />
          <Field
            label="Iter · Tools"
            value={`${run.iterations ?? '—'} · ${run.toolCalls ?? '—'}`}
            mono
          />
          <Field label="Started" value={formatDate(run.startedAt)} mono />
          <Field
            label="Finished"
            value={run.finishedAt ? formatDate(run.finishedAt) : '—'}
            mono
          />
          <Field label="Run-ID" value={run.id} mono />
          <Field label="Routine-ID" value={run.routineId} mono />
        </dl>
        {run.errorMessage ? (
          <div className="mt-6 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-3 font-mono text-[12px] text-[color:var(--danger)]">
            <div className="text-[10px] uppercase tracking-[0.16em]">
              Fehler
            </div>
            <div className="mt-1 break-words">{run.errorMessage}</div>
          </div>
        ) : null}
      </header>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-[22px] border border-[color:var(--divider)] bg-[color:var(--surface)] p-6">
          <SectionTitle>Prompt</SectionTitle>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-[color:var(--surface-muted)] p-3 font-mono text-[12px] text-[color:var(--fg-muted)]">
            {run.prompt}
          </pre>
        </div>
        <div className="rounded-[22px] border border-[color:var(--divider)] bg-[color:var(--surface)] p-6">
          <SectionTitle>Antwort</SectionTitle>
          {run.answer ? (
            <div className="mt-3">
              <Markdown source={run.answer} />
            </div>
          ) : (
            <div className="mt-3 text-[12px] text-[color:var(--fg-subtle)]">
              Keine Antwort gespeichert (Run vor Delivery abgebrochen oder
              fehlgeschlagen).
            </div>
          )}
        </div>
      </section>

      <section className="mt-8 rounded-[22px] border border-[color:var(--divider)] bg-[color:var(--surface)] p-6">
        <SectionTitle>Call-Stack · Run-Trace</SectionTitle>
        <p className="mt-2 text-[12px] text-[color:var(--fg-subtle)]">
          Vollständiger agentischer Trace dieses Runs — Iterationen,
          orchestrator-tool-calls und sub-agent-invocations. Klick auf eine
          Zeile expandiert / collapse-t den Knoten.
        </p>
        <div className="mt-4">
          <RunTraceViewer trace={run.runTrace} />
        </div>
      </section>
    </>
  );
}

function SectionTitle({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'danger' | 'warn';
}): React.ReactElement {
  const colorVar =
    tone === 'ok' ? '--ok' : tone === 'danger' ? '--danger' : tone === 'warn' ? '--warn' : null;
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        {label}
      </dt>
      <dd
        className={`mt-1 truncate ${mono ? 'font-mono text-[11px]' : ''}`}
        style={
          colorVar
            ? { color: `var(${colorVar})` }
            : { color: 'var(--fg-muted)' }
        }
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function triggerLabel(trigger: 'cron' | 'catchup' | 'manual'): string {
  return trigger === 'cron'
    ? 'Cron'
    : trigger === 'catchup'
      ? 'Catch-up'
      : 'Manuell';
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('de-DE', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const min = Math.floor(s / 60);
  const rem = (s - min * 60).toFixed(1);
  return `${min}m ${rem}s`;
}
