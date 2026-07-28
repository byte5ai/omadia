'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import { DevJobStatusText } from '@/app/_components/devjobs/DevJobStatusText';
import {
  DEV_JOB_UI_PHASES,
  DevJobPhaseRail,
  computePhaseStops,
  statusIsLive,
  type DevJobUiPhase,
} from '@/app/_components/devjobs/DevJobPhaseRail';
import { useDevJobEvents, type DevJobEventMessage } from '@/app/_lib/useDevJobEvents';
import { JobLogPane, type LogConnection, type LogLine } from '../../_components/JobLogPane';
import { cancelJob, getJob, isTerminalStatus, type DevJobView } from '../../_lib/api';

/**
 * Epic #470 W0 — the job-detail signature screen (UI spec §5). Header, the
 * phase rail (keyboard-operable, deep-linkable via `?phase=`), then a two-column
 * body: the log pane (driven by rail selection) and a metadata sidebar. The
 * live log streams over SSE through `useDevJobEvents` and sticks to bottom via
 * `useStickToBottom`. W0 is minimal: only the `implement` phase has a live-log
 * pane; other phases show "no artifact yet" (W2 fills them in).
 */

function shortHash(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

function eventToLine(ev: DevJobEventMessage): LogLine | null {
  const p = ev.payload as Record<string, unknown>;
  if (ev.type === 'tool') {
    const name = typeof p['name'] === 'string' ? p['name'] : 'tool';
    const preview =
      typeof p['inputPreview'] === 'string'
        ? p['inputPreview']
        : typeof p['outputPreview'] === 'string'
          ? p['outputPreview']
          : '';
    return { id: String(ev.id), stream: 'tool', text: preview ? `${name} ${preview}` : name };
  }
  if (ev.type === 'log') {
    const text = typeof p['text'] === 'string' ? p['text'] : '';
    if (!text) return null;
    return { id: String(ev.id), stream: p['stream'] === 'stderr' ? 'stderr' : 'agent', text };
  }
  return null;
}

export default function JobDetailPage(): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail');
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const id = params?.id ?? '';

  const [job, setJob] = useState<DevJobView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [conn, setConn] = useState<LogConnection>('reconnecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [agoSec, setAgoSec] = useState<number | null>(null);
  const [closedOnce, setClosedOnce] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const terminalRef = useRef(false);
  useEffect(() => {
    terminalRef.current = job ? isTerminalStatus(job.status) : false;
  }, [job]);

  // Initial load — the header can render from the route param immediately.
  useEffect(() => {
    if (!id) return;
    void getJob(id).then(
      (j) => setJob(j),
      () => setNotFound(true),
    );
  }, [id]);

  const handleEvent = useCallback((ev: DevJobEventMessage) => {
    setLastEventAt(Date.now());
    const line = eventToLine(ev);
    if (line) setLines((prev) => [...prev, line]);
    if (ev.type === 'status' || ev.type === 'phase') {
      // Re-sync the authoritative view on lifecycle transitions.
      void getJob(ev.jobId).then(
        (j) => setJob(j),
        () => {},
      );
    }
  }, []);

  useDevJobEvents(id, handleEvent, {
    enabled: !closedOnce,
    onStatus: (s) => {
      if (s === 'open') setConn('live');
      else if (s === 'closed') {
        setConn('closed');
        setClosedOnce(true);
      } else {
        // transient error — reconnecting, unless the job is already terminal
        // (then the server-side close is expected: stop and mark finished).
        if (terminalRef.current) {
          setConn('closed');
          setClosedOnce(true);
        } else {
          setConn('reconnecting');
        }
      }
    },
  });

  // Tick the "last event Ns ago" counter while live.
  useEffect(() => {
    if (conn !== 'live') return;
    const timer = setInterval(() => {
      setAgoSec(lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : 0);
    }, 1000);
    return () => clearInterval(timer);
  }, [conn, lastEventAt]);

  // Deep-link: the viewed phase comes from `?phase=`.
  const rawPhase = search?.get('phase') ?? null;
  const selected: DevJobUiPhase | null =
    rawPhase && (DEV_JOB_UI_PHASES as readonly string[]).includes(rawPhase) ? (rawPhase as DevJobUiPhase) : null;

  const selectPhase = useCallback(
    (phase: DevJobUiPhase) => {
      const q = new URLSearchParams(search?.toString() ?? '');
      q.set('phase', phase);
      router.replace(`/admin/dev-platform/jobs/${encodeURIComponent(id)}?${q.toString()}`);
    },
    [id, router, search],
  );

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-6 py-12">
        <p className="text-sm text-[color:var(--danger)]">{t('notFound')}</p>
      </div>
    );
  }

  const { stops, current } = job ? computePhaseStops(job) : { stops: [], current: 'implement' as DevJobUiPhase };
  const effective: DevJobUiPhase = selected ?? current;
  const live = job ? statusIsLive(job.status) : false;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-8 lg:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--border)] pb-4">
        <div>
          <div className="flex items-center gap-3 text-sm">
            <span className="font-mono text-[color:var(--fg-strong)]">{t('jobLabel', { hash: shortHash(id) })}</span>
            {job ? <span className="text-[color:var(--fg-muted)]">{job.kind}</span> : null}
            {job ? (
              <Link
                href={`/admin/dev-platform?tab=jobs`}
                className="text-[color:var(--accent)] underline"
              >
                {job.repoId.slice(0, 8)}
              </Link>
            ) : null}
            {job ? <DevJobStatusText status={job.status} /> : null}
          </div>
          <p className="mt-1 max-w-[70ch] truncate text-sm text-[color:var(--fg-muted)]" title={job?.brief}>
            {job?.brief ?? t('loading')}
          </p>
        </div>
        {job && !isTerminalStatus(job.status) ? (
          <Button variant="danger" size="sm" onClick={() => setConfirmCancel(true)}>
            {t('cancel.action')}
          </Button>
        ) : null}
      </div>

      {/* Phase rail */}
      <div className="mt-4">
        <DevJobPhaseRail stops={stops} current={current} selected={selected} onSelect={selectPhase} live={live} />
      </div>

      {/* Body */}
      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          {effective === 'implement' ? (
            <JobLogPane lines={lines} connection={conn} lastEventAgoSec={agoSec} />
          ) : effective === 'pr' && job?.prUrl ? (
            <div className="rounded-lg border border-[color:var(--border)] p-4 text-sm">
              <a href={job.prUrl} target="_blank" rel="noreferrer" className="text-[color:var(--accent)] underline">
                {t('openPr')}
              </a>
              {job.result?.summary ? (
                <p className="mt-2 text-[color:var(--fg-muted)]">{job.result.summary}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--fg-subtle)]">{t('noArtifact')}</p>
          )}
        </div>

        {/* Sidebar */}
        <aside>
          {job ? <Sidebar job={job} /> : null}
        </aside>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        tone="danger"
        title={t('cancel.title')}
        body={t('cancel.body')}
        confirmLabel={t('cancel.confirm')}
        cancelLabel={t('cancel.cancelLabel')}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          void cancelJob(id).then(
            () => getJob(id).then((j) => setJob(j), () => {}),
            () => {},
          );
        }}
      />
    </div>
  );
}

function Sidebar({ job }: { job: DevJobView }): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail.sidebar');
  const format = useFormatter();
  const dt = 'text-xs uppercase tracking-wide text-[color:var(--fg-subtle)]';
  const dd = 'font-mono text-sm tabular-nums text-[color:var(--fg)]';
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded-lg border border-[color:var(--border)] p-4">
      <dt className={dt}>{t('backend')}</dt>
      <dd className={dd}>{job.backend}</dd>
      <dt className={dt}>{t('agent')}</dt>
      <dd className={dd}>{job.agentKind}</dd>
      <dt className={dt}>{t('branch')}</dt>
      <dd className={`${dd} break-all`}>{job.branch ?? '—'}</dd>
      <dt className={dt}>{t('source')}</dt>
      <dd className={dd}>{job.sourceRef ?? job.source}</dd>
      <dt className={dt}>{t('createdBy')}</dt>
      <dd className={dd}>{job.createdBy}</dd>
      <dt className={dt}>{t('tokens')}</dt>
      <dd className={dd}>
        {format.number(job.usage.input)} / {format.number(job.usage.output)}
      </dd>
      <dt className={dt}>{t('cost')}</dt>
      <dd className={dd}>{format.number(job.usage.costUsd, { style: 'currency', currency: 'USD' })}</dd>
    </dl>
  );
}
