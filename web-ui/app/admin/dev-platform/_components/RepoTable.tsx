'use client';

import { useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import type { DevRepoCredentialKind, DevRepoView } from '../_lib/api';

/**
 * Epic #470 W0 — the repo list (UI spec §2). One full-width table panel; state
 * is text color + row edges only, never a filled chip. The first-run empty
 * state is a centered panel with the "omadia never merges" framing.
 */

const thCls =
  'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--fg-muted)]';
const tdCls = 'px-2 py-2 text-sm align-top';

function credentialClass(kind: DevRepoCredentialKind): string {
  if (kind === 'github_app') return 'text-[color:var(--success)]';
  if (kind === 'device_flow') return 'text-[color:var(--warning)]';
  return 'text-[color:var(--fg-muted)]';
}

function credentialKey(kind: DevRepoCredentialKind): 'githubApp' | 'deviceFlow' | 'pat' {
  if (kind === 'github_app') return 'githubApp';
  if (kind === 'device_flow') return 'deviceFlow';
  return 'pat';
}

export function RepoTable({
  repos,
  onNewJob,
  onRemove,
  onRecheck,
  recheckingId,
}: {
  repos: DevRepoView[];
  onNewJob: (repo: DevRepoView) => void;
  onRemove: (repo: DevRepoView) => void;
  onRecheck: (repo: DevRepoView) => void;
  recheckingId: string | null;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repos');
  const [pendingRemove, setPendingRemove] = useState<DevRepoView | null>(null);

  if (repos.length === 0) {
    return (
      <div className="mx-auto max-w-xl rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-6 text-center">
        <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">{t('empty.heading')}</h2>
        <p className="mt-2 text-sm text-[color:var(--fg-muted)]">{t('empty.body')}</p>
        <div className="mt-4 flex justify-center">
          <Link href="/admin/dev-platform/repos/new">
            <Button variant="primary" size="sm">
              {t('empty.cta')}
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-[color:var(--fg-muted)]">{t('count', { count: repos.length })}</span>
        <Link href="/admin/dev-platform/repos/new">
          <Button variant="primary" size="sm">
            {t('add')}
          </Button>
        </Link>
      </div>
      <div className="overflow-x-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40">
        <table className="w-full min-w-max border-collapse">
          <thead>
            <tr className="border-b border-[color:var(--border)]">
              <th className={thCls}>{t('name')}</th>
              <th className={thCls}>{t('forge')}</th>
              <th className={thCls}>{t('credential')}</th>
              <th className={thCls}>{t('branch')}</th>
              <th className={thCls}>{t('protectionCol')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => {
              const expired = !repo.credential.isSet;
              return (
                <tr
                  key={repo.id}
                  className={`border-b border-[color:var(--border)]/60 ${
                    expired ? 'border-l-2 border-l-[color:var(--danger-edge)]' : ''
                  }`}
                >
                  <td className={tdCls}>
                    <div className="text-[color:var(--fg-strong)]">
                      {repo.owner}/{repo.name}
                    </div>
                    <div className="font-mono text-xs text-[color:var(--fg-subtle)]">{repo.cloneUrl}</div>
                    {expired ? (
                      <div className="text-xs text-[color:var(--danger)]">{t('credentialExpired')}</div>
                    ) : null}
                  </td>
                  <td className={tdCls}>{repo.forgeKind}</td>
                  <td className={tdCls}>
                    <span className={credentialClass(repo.credential.kind)}>
                      {t(`credentialModes.${credentialKey(repo.credential.kind)}`)}
                    </span>
                  </td>
                  <td className={`${tdCls} font-mono text-xs`}>{repo.defaultBranch}</td>
                  <td className={tdCls}>
                    <ProtectionCell repo={repo} onRecheck={onRecheck} rechecking={recheckingId === repo.id} />
                  </td>
                  <td className={tdCls}>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => onNewJob(repo)}>
                        {t('newJob')}
                      </Button>
                      <Link href={`/admin/dev-platform/repos/${encodeURIComponent(repo.id)}`}>
                        <Button size="sm" variant="ghost">
                          {t('settings')}
                        </Button>
                      </Link>
                      <Button size="sm" variant="danger" onClick={() => setPendingRemove(repo)}>
                        {t('remove.action')}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        tone="danger"
        title={t('remove.title')}
        body={t('remove.body')}
        confirmLabel={t('remove.confirm')}
        cancelLabel={t('remove.cancel')}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) onRemove(pendingRemove);
          setPendingRemove(null);
        }}
      />
    </div>
  );
}

function ProtectionCell({
  repo,
  onRecheck,
  rechecking,
}: {
  repo: DevRepoView;
  onRecheck: (repo: DevRepoView) => void;
  rechecking: boolean;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repos.protection');
  if (repo.branchProtectionOk === true) {
    return <span className="text-[color:var(--success)]">{t('protected')}</span>;
  }
  if (repo.branchProtectionOk === false) {
    return (
      <span className="text-[color:var(--danger)]" title={t('warning')}>
        {t('unprotected')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-[color:var(--fg-subtle)]">{t('unchecked')}</span>
      <Button
        size="sm"
        variant="ghost"
        busy={rechecking}
        busyLabel={t('rechecking')}
        onClick={() => onRecheck(repo)}
      >
        {t('recheck')}
      </Button>
    </span>
  );
}
