'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ProtectionCheckList } from '../../_components/ProtectionCheckList';
import { checkRepo, getRepo, type DevRepoView } from '../../_lib/api';

/**
 * Epic #470 W0 — repo detail / settings (UI spec §1 route). Minimal in W0: the
 * onboarded facts plus an on-demand branch-protection re-check (spec §2 "the
 * check runs on demand from the repo row" — here from the detail page too).
 */

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; repo: DevRepoView }
  | { kind: 'error' };

export default function RepoDetailPage(): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repoDetail');
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [rechecking, setRechecking] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    void getRepo(id).then(
      (repo) => setState({ kind: 'ready', repo }),
      () => setState({ kind: 'error' }),
    );
  }, [id]);

  useEffect(load, [load]);

  if (state.kind === 'loading') {
    return <Shell><p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p></Shell>;
  }
  if (state.kind === 'error') {
    return <Shell><p className="text-sm text-[color:var(--danger)]">{t('loadError')}</p></Shell>;
  }

  const { repo } = state;
  return (
    <Shell>
      <h1 className="font-display text-[clamp(1.5rem,3vw,2.25rem)] leading-[1.1] text-[color:var(--fg-strong)]">
        {repo.owner}/{repo.name}
      </h1>
      <p className="mt-1 font-mono text-xs text-[color:var(--fg-subtle)]">{repo.cloneUrl}</p>

      <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-[color:var(--fg-subtle)]">{t('forge')}</dt>
        <dd>{repo.forgeKind}</dd>
        <dt className="text-[color:var(--fg-subtle)]">{t('branch')}</dt>
        <dd className="font-mono">{repo.defaultBranch}</dd>
        <dt className="text-[color:var(--fg-subtle)]">{t('credential')}</dt>
        <dd>{repo.credential.kind}{repo.credential.login ? ` (${repo.credential.login})` : ''}</dd>
        <dt className="text-[color:var(--fg-subtle)]">{t('runsTests')}</dt>
        <dd>{repo.runsTests ? t('yes') : t('no')}</dd>
      </dl>

      <div className="mt-6 rounded-lg border border-[color:var(--border)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">{t('protectionHeading')}</h2>
          <Button
            size="sm"
            variant="secondary"
            busy={rechecking}
            busyLabel={t('rechecking')}
            onClick={() => {
              setRechecking(true);
              void checkRepo(repo.id).then(
                () => {
                  setRechecking(false);
                  load();
                },
                () => setRechecking(false),
              );
            }}
          >
            {t('recheck')}
          </Button>
        </div>
        <ProtectionCheckList branch={repo.defaultBranch} ok={repo.branchProtectionOk} />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.ReactElement {
  const t = useTranslations('adminDevPlatform.repoDetail');
  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-12 lg:px-8 lg:py-16">
      <div className="mb-6">
        <Link href="/admin/dev-platform?tab=repos" className="text-sm text-[color:var(--accent)] underline">
          {t('back')}
        </Link>
      </div>
      {children}
    </div>
  );
}
