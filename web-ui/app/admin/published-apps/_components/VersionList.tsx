'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { listPublishedVersions, type PublishedVersionsResponse } from '../../../_lib/adminPublish';
import { ErrorLine, Mono, MutedLine, useDateText, useErrorText } from '../../_components/AdminSurface';

/** The immutable version log of one app, newest first. */
export function VersionList({ appId }: { appId: string }): React.ReactElement {
  const t = useTranslations('adminPublish.versions');
  const date = useDateText();
  const errorText = useErrorText({ 'publish_admin.not_found': t('notFound') });
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; data: PublishedVersionsResponse } | { kind: 'error'; error: unknown }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await listPublishedVersions(appId);
        if (!cancelled) setState({ kind: 'ready', data });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId]);

  if (state.kind === 'loading') return <MutedLine text={t('loading')} />;
  if (state.kind === 'error') return <ErrorLine text={errorText(state.error)} />;

  return (
    <ol className="flex flex-col gap-2">
      {state.data.versions.map((v) => (
        <li
          key={v.version}
          className={
            v.current
              ? 'rounded-md border border-[color:var(--accent)] px-3 py-2'
              : 'rounded-md border border-[color:var(--border)]/60 px-3 py-2'
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t('label', { version: v.version })}</span>
            <span>{v.name}</span>
            {v.current ? (
              <span className="rounded-full bg-[color:var(--accent)]/15 px-2 text-xs text-[color:var(--accent)]">
                {t('live')}
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-xs text-[color:var(--fg-muted)]">
            {t('meta', { date: date(v.created_at), entrypoint: v.entrypoint })}
          </div>
          <div className="mt-1 text-xs text-[color:var(--fg-muted)]">
            {t('source')} <Mono>{v.source_scope_key}</Mono> · {t('hash')} <Mono>{v.dir_hash.slice(0, 12)}</Mono>
          </div>
        </li>
      ))}
    </ol>
  );
}
