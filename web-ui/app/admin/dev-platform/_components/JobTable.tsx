'use client';

import { useState } from 'react';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import { DevJobStatusText, statusRowEdge } from '@/app/_components/devjobs/DevJobStatusText';
import { budgetState } from '../_lib/budget';
import { isTerminalStatus, type DevJobStatus, type DevJobView, type DevRepoView } from '../_lib/api';

/**
 * Epic #470 W0 — the job list (UI spec §4). Same table-panel recipe as the repo
 * list. Status rendering routes through `DevJobStatusText` (the single §4 token
 * mapping) and `waiting`/`failed` rows carry a left edge — text + edges only,
 * never a filled chip. Cost and age format through `useFormatter()`.
 */

const thCls =
  'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--fg-muted)]';
const tdCls = 'px-2 py-2 text-sm align-top';

function shortHash(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

export function JobTable({
  jobs,
  repos,
  onCancel,
}: {
  jobs: DevJobView[];
  repos: DevRepoView[];
  onCancel: (job: DevJobView) => void;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.jobs');
  const tKind = useTranslations('adminDevPlatform.jobs.kinds');
  const format = useFormatter();
  const [pendingCancel, setPendingCancel] = useState<DevJobView | null>(null);

  const repoName = (repoId: string): string => {
    const r = repos.find((x) => x.id === repoId);
    return r ? `${r.owner}/${r.name}` : repoId.slice(0, 8);
  };

  if (jobs.length === 0) {
    return <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40">
        <table className="w-full min-w-max border-collapse">
          <thead>
            <tr className="border-b border-[color:var(--border)]">
              <th className={thCls}>{t('job')}</th>
              <th className={thCls}>{t('repo')}</th>
              <th className={thCls}>{t('kind')}</th>
              <th className={thCls}>{t('phase')}</th>
              <th className={thCls}>{t('status')}</th>
              <th className={`${thCls} text-right`}>{t('cost')}</th>
              <th className={thCls}>{t('age')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const edge = statusRowEdge(job.status);
              return (
                <tr
                  key={job.id}
                  className={`border-b border-[color:var(--border)]/60 ${edge ?? ''}`}
                >
                  <td className={tdCls}>
                    <div className="font-mono text-xs text-[color:var(--fg-strong)]">{shortHash(job.id)}</div>
                    <div className="max-w-[28ch] truncate text-xs text-[color:var(--fg-muted)]" title={job.brief}>
                      {job.brief}
                    </div>
                  </td>
                  <td className={tdCls}>{repoName(job.repoId)}</td>
                  <td className={tdCls}>{tKind(kindKey(job.kind))}</td>
                  <td className={`${tdCls} font-mono text-xs`}>{job.phase}</td>
                  <td className={tdCls}>
                    <DevJobStatusText status={job.status} />
                  </td>
                  <td className={`${tdCls} text-right font-mono tabular-nums`}>
                    <CostCell usage={job.usage} status={job.status} />
                  </td>
                  <td className={tdCls}>{format.relativeTime(new Date(job.createdAt))}</td>
                  <td className={tdCls}>
                    <div className="flex justify-end gap-1">
                      <Link href={`/admin/dev-platform/jobs/${encodeURIComponent(job.id)}`}>
                        <Button size="sm" variant="ghost">
                          {t('view')}
                        </Button>
                      </Link>
                      {isTerminalStatus(job.status) ? null : (
                        <Button size="sm" variant="danger" onClick={() => setPendingCancel(job)}>
                          {t('cancel')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pendingCancel !== null}
        tone="danger"
        title={t('cancelConfirm.title')}
        body={t('cancelConfirm.body')}
        confirmLabel={t('cancelConfirm.confirm')}
        cancelLabel={t('cancelConfirm.cancel')}
        onCancel={() => setPendingCancel(null)}
        onConfirm={() => {
          if (pendingCancel) onCancel(pendingCancel);
          setPendingCancel(null);
        }}
      />
    </div>
  );
}

function kindKey(kind: DevJobView['kind']): 'analyze' | 'fixIssue' | 'implement' {
  if (kind === 'fix_issue') return 'fixIssue';
  return kind;
}

/**
 * Cost cell (spec §5) — the spend, and when a budget applies, `spent / budget`
 * with a text-only state: warning at ≥80%, error at ≥100% (or a
 * `budget_exceeded` job). Estimated cost carries a `~` and an "est." tag so the
 * operator never mistakes a subscription-CLI estimate for a metered charge.
 * State is text color only — Lume forbids filled chips (§4/§13).
 */
function CostCell({
  usage,
  status,
}: {
  usage: DevJobView['usage'];
  status: DevJobStatus;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.jobs');
  const format = useFormatter();
  const { costUsd, budgetCostUsd, estimated } = usage;
  const state = status === 'budget_exceeded' ? 'over' : budgetState(costUsd, budgetCostUsd);
  const colorCls =
    state === 'over'
      ? 'text-[color:var(--danger)]'
      : state === 'near'
        ? 'text-[color:var(--warning)]'
        : 'text-[color:var(--fg-strong)]';
  const asMoney = (n: number): string => format.number(n, { style: 'currency', currency: 'USD' });
  const title = estimated
    ? t('costEstimatedTitle')
    : state === 'over'
      ? t('costOverTitle')
      : state === 'near'
        ? t('costNearTitle')
        : undefined;

  return (
    <span className={`inline-flex items-baseline justify-end gap-1 ${colorCls}`} title={title}>
      <span>
        {estimated ? <span aria-hidden>~</span> : null}
        {asMoney(costUsd)}
      </span>
      {budgetCostUsd != null ? (
        <span className="text-[color:var(--fg-subtle)]">/ {asMoney(budgetCostUsd)}</span>
      ) : null}
      {estimated ? (
        <span className="text-[10px] uppercase tracking-[0.08em] text-[color:var(--fg-subtle)]">
          {t('costEstimatedTag')}
        </span>
      ) : null}
    </span>
  );
}
