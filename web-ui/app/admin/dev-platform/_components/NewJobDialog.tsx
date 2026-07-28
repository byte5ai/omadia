'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  createJob,
  listRepoIssues,
  type DevIssueSummary,
  type DevJobKind,
  type DevRepoView,
} from '../_lib/api';

/**
 * Epic #470 W0 — start a job against a repo (UI spec §2 "New job"). A compact
 * dialog: pick a kind and either an open GitHub issue (the shippable-outcome
 * path — "pick issue #123") or a free-text brief. Backend defaults to `docker`
 * (W1's shipping backend). No spinner — the submit uses `Button busy`.
 */

const inputCls =
  'rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

export function NewJobDialog({
  repo,
  onClose,
  onCreated,
}: {
  repo: DevRepoView;
  onClose: () => void;
  onCreated: (jobId: string) => void;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.newJob');
  const [kind, setKind] = useState<DevJobKind>('fix_issue');
  const [source, setSource] = useState<'issue' | 'brief'>('issue');
  const [issues, setIssues] = useState<DevIssueSummary[] | null>(null);
  const [issueNumber, setIssueNumber] = useState<number | null>(null);
  const [brief, setBrief] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listRepoIssues(repo.id, 30).then(
      (res) => {
        if (alive) setIssues(res.issues);
      },
      () => {
        if (alive) setIssues([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [repo.id]);

  const ready = source === 'issue' ? issueNumber !== null : brief.trim().length > 0;

  const submit = (): void => {
    setSubmitting(true);
    setErrorKey(null);
    void (async () => {
      try {
        const job = await createJob({
          repoId: repo.id,
          kind,
          backend: 'docker',
          ...(source === 'issue' && issueNumber !== null ? { issueNumber } : { brief: brief.trim() }),
        });
        onCreated(job.id);
      } catch {
        setErrorKey('submit');
        setSubmitting(false);
      }
    })();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('title', { repo: `${repo.owner}/${repo.name}` })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-5 shadow-lg">
        <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">
          {t('title', { repo: `${repo.owner}/${repo.name}` })}
        </h2>

        <label className="mt-4 flex flex-col gap-1 text-xs">
          <span className="text-[color:var(--fg-muted)]">{t('kind')}</span>
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as DevJobKind)}>
            <option value="fix_issue">{t('kinds.fixIssue')}</option>
            <option value="analyze">{t('kinds.analyze')}</option>
            <option value="implement">{t('kinds.implement')}</option>
          </select>
        </label>

        <div className="mt-4 flex gap-2">
          <Button size="sm" variant={source === 'issue' ? 'primary' : 'ghost'} onClick={() => setSource('issue')}>
            {t('fromIssue')}
          </Button>
          <Button size="sm" variant={source === 'brief' ? 'primary' : 'ghost'} onClick={() => setSource('brief')}>
            {t('fromBrief')}
          </Button>
        </div>

        {source === 'issue' ? (
          <div className="mt-3">
            {issues === null ? (
              <p className="text-sm text-[color:var(--fg-muted)]">{t('loadingIssues')}</p>
            ) : issues.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">{t('noIssues')}</p>
            ) : (
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[color:var(--fg-muted)]">{t('issue')}</span>
                <select
                  className={inputCls}
                  value={issueNumber ?? ''}
                  onChange={(e) => setIssueNumber(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">{t('selectIssue')}</option>
                  {issues.map((issue) => (
                    <option key={issue.number} value={issue.number}>
                      #{issue.number} — {issue.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : (
          <label className="mt-3 flex flex-col gap-1 text-xs">
            <span className="text-[color:var(--fg-muted)]">{t('brief')}</span>
            <textarea
              className={`${inputCls} min-h-[96px]`}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={t('briefPlaceholder')}
            />
          </label>
        )}

        {errorKey ? <p className="mt-3 text-sm text-[color:var(--danger)]">{t('error')}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" busy={submitting} busyLabel={t('starting')} disabled={!ready} onClick={submit}>
            {t('start')}
          </Button>
        </div>
      </div>
    </div>
  );
}
