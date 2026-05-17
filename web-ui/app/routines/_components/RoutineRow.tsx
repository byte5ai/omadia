'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';

import {
  listRoutineRuns,
  type RoutineDto,
  type RoutineRunSummaryDto,
} from '../../_lib/api';
import { RoutineActions } from './RoutineActions';
import { RoutineTemplateEditor } from './RoutineTemplateEditor';

interface Props {
  routine: RoutineDto;
}

const COLSPAN = 7;
const HISTORY_LIMIT = 10;

/**
 * One row in the routines table. Hosts its own expand-state so the table
 * stays a pure server-component shell — only the rows are interactive.
 *
 * Run-history is fetched lazily on first expand (and cached per-row in
 * component state). Re-expanding does not refetch; the operator can hit
 * the "Refresh" button to pull a fresh batch (or open a single run's
 * detail page, which always reads from the server).
 */
export function RoutineRow({ routine }: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [runs, setRuns] = useState<RoutineRunSummaryDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listRoutineRuns(routine.id, { limit: HISTORY_LIMIT });
      setRuns(resp.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [routine.id]);

  const handleToggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    if (next && runs === null && !loading) {
      void loadRuns();
    }
  };

  const handleDetailsToggle = (): void => {
    setDetailsExpanded((v) => !v);
  };

  return (
    <>
      <tr className="border-t border-[color:var(--border)] align-top">
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={handleDetailsToggle}
            aria-expanded={detailsExpanded}
            aria-controls={`details-${routine.id}`}
            className="group flex w-full items-start gap-2 text-left"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center text-[10px] text-[color:var(--fg-subtle)] transition-transform group-hover:text-[color:var(--fg-strong)]"
              style={{
                transform: detailsExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            >
              ▸
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate font-semibold text-[color:var(--fg-strong)] group-hover:text-[color:var(--accent)]"
                title={routine.name}
              >
                {routine.name}
              </span>
              <span
                className="mt-1 block truncate font-mono text-[11px] text-[color:var(--fg-subtle)]"
                title={routine.id}
              >
                {routine.id}
              </span>
              {detailsExpanded ? null : (
                <span
                  className="mt-2 block truncate text-[12px] text-[color:var(--fg-muted)]"
                  title={routine.prompt}
                >
                  {routine.prompt}
                </span>
              )}
            </span>
          </button>
        </td>
        <td className="px-4 py-3 font-mono text-[12px] text-[color:var(--fg-muted)]">
          <div className="truncate" title={routine.userId}>
            {routine.userId}
          </div>
          <div
            className="truncate text-[10px] text-[color:var(--fg-subtle)]"
            title={routine.tenant}
          >
            {routine.tenant}
          </div>
        </td>
        <td className="px-4 py-3 font-mono text-[12px] text-[color:var(--fg-muted)]">
          <div className="whitespace-nowrap" title={routine.cron}>
            {routine.cron}
          </div>
          <div className="mt-1 whitespace-nowrap text-[10px] text-[color:var(--fg-subtle)]">
            timeout {(routine.timeoutMs / 1000).toFixed(0)}s
          </div>
        </td>
        <td className="px-4 py-3 font-mono text-[12px] text-[color:var(--fg-muted)]">
          {routine.channel}
        </td>
        <td className="px-4 py-3">
          <StatusBadge status={routine.status} />
        </td>
        <td className="px-4 py-3 text-[12px] text-[color:var(--fg-muted)]">
          {routine.lastRunAt ? (
            <>
              <div className="whitespace-nowrap">
                {formatDate(routine.lastRunAt)}
              </div>
              <div
                className={
                  routine.lastRunStatus === 'ok'
                    ? 'text-[color:var(--ok)]'
                    : routine.lastRunStatus === null
                      ? ''
                      : 'text-[color:var(--danger)]'
                }
              >
                {routine.lastRunStatus ?? '—'}
              </div>
              {routine.lastRunError ? (
                <div
                  className="mt-1 truncate font-mono text-[10px] text-[color:var(--danger)]"
                  title={routine.lastRunError}
                >
                  {routine.lastRunError}
                </div>
              ) : null}
              <button
                type="button"
                onClick={handleToggle}
                className="mt-2 inline-flex items-center gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--fg-strong)]"
                aria-expanded={expanded}
                aria-controls={`runs-${routine.id}`}
              >
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                Runs
              </button>
            </>
          ) : (
            <span className="text-[color:var(--fg-subtle)]">noch nie</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <RoutineActions routine={routine} />
        </td>
      </tr>
      {detailsExpanded ? (
        <tr
          id={`details-${routine.id}`}
          className="border-t border-[color:var(--border)] bg-[color:var(--surface-muted)]"
        >
          <td colSpan={COLSPAN} className="px-4 py-4">
            <DetailsPanel routine={routine} />
          </td>
        </tr>
      ) : null}
      {expanded ? (
        <tr
          id={`runs-${routine.id}`}
          className="border-t border-[color:var(--border)] bg-[color:var(--surface-muted)]"
        >
          <td colSpan={COLSPAN} className="px-4 py-4">
            <RunHistoryPanel
              routineId={routine.id}
              runs={runs}
              loading={loading}
              error={error}
              onRefresh={(): void => {
                void loadRuns();
              }}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DetailsPanel({ routine }: { routine: RoutineDto }): React.ReactElement {
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          Prompt
        </div>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-3 font-mono text-[12px] leading-relaxed text-[color:var(--fg-strong)]">
          {routine.prompt}
        </pre>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailField label="Routine-ID" value={routine.id} mono />
        <DetailField label="User-ID" value={routine.userId} mono />
        <DetailField label="Tenant" value={routine.tenant} mono />
        <DetailField label="Channel" value={routine.channel} mono />
        <DetailField label="Cron" value={routine.cron} mono />
        <DetailField
          label="Timeout"
          value={`${(routine.timeoutMs / 1000).toFixed(0)}s (${routine.timeoutMs}ms)`}
          mono
        />
        <DetailField label="Status" value={routine.status} />
        <DetailField
          label="Letzter Lauf"
          value={
            routine.lastRunAt
              ? `${formatDate(routine.lastRunAt)} · ${routine.lastRunStatus ?? '—'}`
              : 'noch nie'
          }
        />
      </div>
      {routine.lastRunError ? (
        <div className="rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--danger)]">
            Letzter Fehler
          </div>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-[color:var(--danger)]">
            {routine.lastRunError}
          </pre>
        </div>
      ) : null}
      <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-3">
        <RoutineTemplateEditor routine={routine} />
      </div>
    </div>
  );
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        {label}
      </div>
      <div
        className={`mt-1 break-all text-[12px] text-[color:var(--fg-strong)] ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}

function RunHistoryPanel({
  routineId,
  runs,
  loading,
  error,
  onRefresh,
}: {
  routineId: string;
  runs: RoutineRunSummaryDto[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
          Letzte {HISTORY_LIMIT} Runs
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--fg-strong)] disabled:opacity-50"
        >
          {loading ? 'Lädt…' : 'Refresh'}
        </button>
      </div>
      {error ? (
        <div className="rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-3 text-[12px] text-[color:var(--danger)]">
          <div className="font-semibold">Run-Historie nicht erreichbar</div>
          <div className="mt-1 font-mono text-[10px]">{error}</div>
        </div>
      ) : runs === null ? (
        <div className="text-[12px] text-[color:var(--fg-subtle)]">Lädt…</div>
      ) : runs.length === 0 ? (
        <div className="text-[12px] text-[color:var(--fg-subtle)]">
          Noch keine Run-Historie für diese Routine — sobald sie zum ersten
          Mal feuert, erscheint hier eine Zeile.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[color:var(--border)] bg-[color:var(--surface)]">
          <table className="w-full text-[12px]">
            <thead className="bg-[color:var(--surface-muted)] text-left text-[10px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Dauer</th>
                <th className="px-3 py-2">Iter · Tools</th>
                <th className="px-3 py-2">Fehler</th>
                <th className="px-3 py-2 text-right">Detail</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className="border-t border-[color:var(--border)]"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-[color:var(--fg-muted)]">
                    {formatDate(run.startedAt)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <TriggerPill trigger={run.trigger} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <RunStatusPill status={run.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-[color:var(--fg-muted)]">
                    {formatDuration(run.durationMs)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-[color:var(--fg-muted)]">
                    {run.iterations ?? '—'} · {run.toolCalls ?? '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-[color:var(--danger)]">
                    {run.errorMessage ? (
                      <span
                        className="line-clamp-2"
                        title={run.errorMessage}
                      >
                        {run.errorMessage}
                      </span>
                    ) : (
                      <span className="text-[color:var(--fg-subtle)]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Link
                      href={`/routines/${routineId}/runs/${run.id}`}
                      className="rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--accent)] transition hover:border-[color:var(--accent)]"
                    >
                      Trace →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: 'active' | 'paused';
}): React.ReactElement {
  const tone = status === 'active' ? 'ok' : 'warn';
  const colorVar = tone === 'ok' ? '--ok' : '--warn';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
      style={{
        color: `var(${colorVar})`,
        backgroundColor: `color-mix(in oklab, var(${colorVar}) 12%, transparent)`,
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: `var(${colorVar})` }}
      />
      {status}
    </span>
  );
}

function TriggerPill({
  trigger,
}: {
  trigger: 'cron' | 'catchup' | 'manual';
}): React.ReactElement {
  const label =
    trigger === 'cron' ? 'Cron' : trigger === 'catchup' ? 'Catch-up' : 'Manuell';
  const colorVar =
    trigger === 'manual'
      ? '--accent'
      : trigger === 'catchup'
        ? '--warn'
        : '--fg-subtle';
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]"
      style={{
        borderColor: `color-mix(in oklab, var(${colorVar}) 30%, transparent)`,
        color: `var(${colorVar})`,
      }}
    >
      {label}
    </span>
  );
}

function RunStatusPill({
  status,
}: {
  status: 'ok' | 'error' | 'timeout';
}): React.ReactElement {
  const colorVar =
    status === 'ok' ? '--ok' : status === 'error' ? '--danger' : '--warn';
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]"
      style={{
        color: `var(${colorVar})`,
        backgroundColor: `color-mix(in oklab, var(${colorVar}) 12%, transparent)`,
      }}
    >
      <span
        className="inline-block h-1 w-1 rounded-full"
        style={{ backgroundColor: `var(${colorVar})` }}
      />
      {status}
    </span>
  );
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
  if (s < 60) return `${s.toFixed(1)}s`;
  const min = Math.floor(s / 60);
  const rem = Math.round(s - min * 60);
  return `${min}m ${rem}s`;
}
