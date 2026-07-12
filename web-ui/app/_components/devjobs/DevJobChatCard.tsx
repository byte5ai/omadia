'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { DevJobStatusText, statusRowEdge } from '@/app/_components/devjobs/DevJobStatusText';
import {
  DevJobPhaseRail,
  computePhaseStops,
  statusIsLive,
} from '@/app/_components/devjobs/DevJobPhaseRail';
import { useDevJobEvents, type DevJobEventMessage } from '@/app/_lib/useDevJobEvents';
import {
  getJob,
  isTerminalStatus,
  listWaitingGates,
  resolveGate,
  type DevGateView,
  type DevJobView,
} from '@/app/admin/dev-platform/_lib/api';

import { findGateForJob, type DevJobCardSeed } from './devJobChatCardState';

/**
 * Epic #470 W3 — the live dev-job card rendered inline in chat when the
 * orchestrator calls `dev_job_start`. Seeded from the tool result, it subscribes
 * to the W0 job-event SSE tail and re-syncs the authoritative job view on every
 * lifecycle transition (mirrors the admin job-detail page).
 *
 * Gate-from-chat: when the job parks at the human gate (`status === 'waiting'`)
 * the card fetches the waiting gate and offers approve/reject that call the W2
 * gate API DIRECTLY (`POST /gates/:id/resolve`) — NOT a chat tool. Gate
 * resolution must be attributable to a HUMAN session (spec §4), and the POST
 * carries the operator's session, so the server authorizes and records the
 * decision against that person.
 *
 * Lume: state is text/edge only — no spinners; the rail's current stop carries
 * the sanctioned `.lume-busy-dots` while the runner is live.
 */
export function DevJobChatCard({ seed }: { seed: DevJobCardSeed }): React.ReactElement {
  const t = useTranslations('chat.devJob');
  const [job, setJob] = useState<DevJobView | null>(null);
  const [gate, setGate] = useState<DevGateView | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState(false);
  const [connLost, setConnLost] = useState(false);

  // Derived during render (not a ref) — reading a ref's .current in render is a
  // react-hooks/refs violation, and this is a pure function of `job` state anyway.
  const isTerminal = job ? isTerminalStatus(job.status) : false;

  const refresh = useCallback(() => {
    void getJob(seed.jobId).then(
      (j) => setJob(j),
      () => {},
    );
  }, [seed.jobId]);

  // Initial authoritative load.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleEvent = useCallback(
    (ev: DevJobEventMessage) => {
      if (ev.type === 'status' || ev.type === 'phase' || ev.type === 'gate' || ev.type === 'approval') {
        refresh();
      }
    },
    [refresh],
  );

  useDevJobEvents(seed.jobId, handleEvent, {
    enabled: !isTerminal,
    onStatus: (s) => {
      if (s === 'open') setConnLost(false);
      else if (s === 'error' && !isTerminal) setConnLost(true);
    },
  });

  // Resolve the waiting gate for this job whenever it parks at the human gate.
  const status = job?.status ?? 'queued';
  useEffect(() => {
    if (status !== 'waiting') {
      setGate(null);
      return;
    }
    let cancelled = false;
    void listWaitingGates().then(
      (res) => {
        if (!cancelled) setGate(findGateForJob(res.gates, seed.jobId));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [status, seed.jobId]);

  const onResolve = useCallback(
    (approved: boolean) => {
      if (!gate) return;
      setResolving(true);
      setResolveError(false);
      void resolveGate(gate.id, { approved }).then(
        () => {
          setResolving(false);
          setGate(null);
          refresh();
        },
        () => {
          setResolving(false);
          setResolveError(true);
        },
      );
    },
    [gate, refresh],
  );

  const phaseSource = job ?? { phase: seed.phase, status };
  const { stops, current } = computePhaseStops(phaseSource);
  const edge = statusRowEdge(status);

  return (
    <div
      className={`rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-2 text-xs ${edge ?? ''}`}
      data-testid="dev-job-chat-card"
      data-status={status}
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold text-[color:var(--fg-strong)]">{t('heading')}</span>
        <span className="truncate font-mono text-[color:var(--fg-muted)]" title={seed.repoId}>
          {job?.kind ? `${job.kind} · ${seed.repoId}` : seed.repoId}
        </span>
        <span className="ml-auto">
          <DevJobStatusText status={status} />
        </span>
      </div>

      <div className="mt-1">
        <DevJobPhaseRail
          stops={stops}
          current={current}
          selected={null}
          onSelect={() => {}}
          live={statusIsLive(status)}
          compact
        />
      </div>

      <div className="mt-1 flex items-center gap-3">
        <Link
          href={`/admin/dev-platform/jobs/${encodeURIComponent(seed.jobId)}`}
          className="text-[color:var(--accent)] underline"
        >
          {t('viewJob')}
        </Link>
        {job?.prUrl ? (
          <a
            href={job.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[color:var(--accent)] underline"
          >
            {t('viewPr')}
          </a>
        ) : null}
        {connLost ? (
          <span className="text-[color:var(--warning)]">{t('connectionLost')}</span>
        ) : null}
      </div>

      {gate ? (
        <div className="mt-2 border-t border-[color:var(--border)] pt-2">
          <div className="mb-1 font-semibold text-[color:var(--warning)]">{t('gate.title')}</div>
          {gate.questions.length > 0 ? (
            <ul className="mb-2 list-disc pl-4 text-[color:var(--fg-muted)]">
              {gate.questions.map((q) => (
                <li key={q.id}>{q.text}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={resolving}
              onClick={() => onResolve(true)}
            >
              {resolving ? t('gate.resolving') : t('gate.approve')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={resolving}
              onClick={() => onResolve(false)}
            >
              {t('gate.reject')}
            </Button>
            {resolveError ? (
              <span className="text-[color:var(--danger)]">{t('gate.error')}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
