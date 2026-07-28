'use client';

import { useTranslations } from 'next-intl';

import type { DevJobStatus } from '@/app/admin/dev-platform/_lib/api';

/**
 * Epic #470 — the single source of the status → text-token mapping (UI spec §4).
 * State is communicated by text color only, never a filled chip; every colored
 * status also carries a literal word (accessibility §13). `provisioning` adds
 * the sanctioned busy affordance (`.lume-busy-dots`) — a verb plus stepped dots,
 * not a spinner. Reused by the job list, the job-detail header, and (W3) the
 * chat job card, so the mapping can never drift between surfaces.
 */

/** Tailwind text-color class per status. */
const STATUS_COLOR: Record<DevJobStatus, string> = {
  queued: 'text-[color:var(--fg-muted)]',
  provisioning: 'text-[color:var(--fg-muted)]',
  running: 'text-[color:var(--accent)]',
  waiting: 'text-[color:var(--warning)]',
  applying: 'text-[color:var(--accent)]',
  done: 'text-[color:var(--success)]',
  failed: 'text-[color:var(--danger)]',
  cancelled: 'text-[color:var(--fg-subtle)]',
  stalled: 'text-[color:var(--warning)]',
  budget_exceeded: 'text-[color:var(--danger)]',
};

/** i18n key per status (`adminDevPlatform.jobs.statuses.*`). */
const STATUS_KEY: Record<DevJobStatus, string> = {
  queued: 'queued',
  provisioning: 'provisioning',
  running: 'running',
  waiting: 'waiting',
  applying: 'applying',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  stalled: 'stalled',
  budget_exceeded: 'budgetExceeded',
};

/** Whether a status shows the busy dots (an in-flight, pre-run wait). */
export function statusHasBusyDots(status: DevJobStatus): boolean {
  return status === 'provisioning';
}

/** The row left-edge class for statuses that flag one (UI spec §4), else null. */
export function statusRowEdge(status: DevJobStatus): string | null {
  if (status === 'waiting') return 'border-l-2 border-l-[color:var(--warning)]';
  if (status === 'failed') return 'border-l-2 border-l-[color:var(--danger-edge)]';
  return null;
}

export function DevJobStatusText({
  status,
  title,
}: {
  status: DevJobStatus;
  /** Optional hover detail (e.g. last heartbeat for `stalled`, budget for `budget_exceeded`). */
  title?: string;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.jobs.statuses');
  return (
    <span
      className={`text-sm ${STATUS_COLOR[status]}`}
      title={title}
      data-status={status}
    >
      {t(STATUS_KEY[status])}
      {statusHasBusyDots(status) ? <span className="lume-busy-dots" aria-hidden /> : null}
    </span>
  );
}
