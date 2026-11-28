'use client';

import { Fragment, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { listPublishedApps, type PublishedAppDto } from '../../_lib/adminPublish';
import {
  CELL_CLASS,
  ErrorLine,
  Mono,
  MutedLine,
  ROW_CLASS,
  SurfaceFrame,
  SurfaceSection,
  TableFrame,
  THEAD_CLASS,
  useDateText,
  useErrorText,
} from '../_components/AdminSurface';
import { VersionList } from './_components/VersionList';

/**
 * Admin → Published apps (#2320, #581, ADR-0067). Every app agents published
 * with its live and newest version, and each app's immutable version log.
 * Read-only.
 */

type Load = { kind: 'loading' } | { kind: 'ready'; apps: PublishedAppDto[] } | { kind: 'error'; error: unknown };

export default function AdminPublishedAppsPage(): React.ReactElement {
  const t = useTranslations('adminPublish');
  const date = useDateText();
  const errorText = useErrorText();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const apps = await listPublishedApps();
        if (!cancelled) setState({ kind: 'ready', apps });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SurfaceFrame title={t('title')} intro={t('intro')}>
      <SurfaceSection heading={t('list.heading')} hint={t('list.hint')}>
        {state.kind === 'loading' ? (
          <MutedLine text={t('loading')} />
        ) : state.kind === 'error' ? (
          <ErrorLine text={errorText(state.error)} />
        ) : state.apps.length === 0 ? (
          <MutedLine text={t('list.empty')} />
        ) : (
          <TableFrame>
            <thead className={THEAD_CLASS}>
              <tr>
                <th className={CELL_CLASS}>{t('list.app')}</th>
                <th className={CELL_CLASS}>{t('list.live')}</th>
                <th className={CELL_CLASS}>{t('list.versions')}</th>
                <th className={CELL_CLASS}>{t('list.updated')}</th>
                <th className={CELL_CLASS}>
                  <span className="sr-only">{t('list.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.apps.map((app) => (
                <Fragment key={app.app_id}>
                  <tr className={ROW_CLASS}>
                    <td className={CELL_CLASS}>
                      <div className="font-medium">{app.name}</div>
                      <Mono>{app.app_id}</Mono>
                    </td>
                    <td className={CELL_CLASS}>
                      {app.current_version === null
                        ? t('list.notLive')
                        : app.current_version === app.latest_version
                          ? t('list.liveLatest', { version: app.current_version })
                          : t('list.liveOlder', { version: app.current_version, latest: app.latest_version })}
                    </td>
                    <td className={CELL_CLASS}>{app.version_count}</td>
                    <td className={`${CELL_CLASS} whitespace-nowrap text-xs text-[color:var(--fg-muted)]`}>
                      {date(app.updated_at)}
                    </td>
                    <td className={CELL_CLASS}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setOpen(open === app.app_id ? null : app.app_id)}
                      >
                        {open === app.app_id ? t('list.hideVersions') : t('list.showVersions')}
                      </Button>
                    </td>
                  </tr>
                  {open === app.app_id ? (
                    <tr className={ROW_CLASS}>
                      <td className={CELL_CLASS} colSpan={5}>
                        <VersionList appId={app.app_id} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </TableFrame>
        )}
      </SurfaceSection>
    </SurfaceFrame>
  );
}
