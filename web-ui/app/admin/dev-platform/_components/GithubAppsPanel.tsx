'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '@/app/_lib/api';
import {
  listGithubApps,
  startGithubAppManifest,
  type DevGithubAppSummary,
} from '../_lib/api';

/**
 * Epic #470 W2 — GitHub App creation + registry (UI spec §2). Two parts:
 *
 *   1. "Create GitHub App" — starts the manifest flow (`POST manifest/start`)
 *      and hands the returned `{ action, manifest }` to GitHub. GitHub's
 *      App-from-manifest endpoint ONLY accepts a real browser FORM POST with a
 *      single `manifest` field — a `fetch` cannot create the App (it needs a
 *      top-level navigation so GitHub can render its own approval screen and
 *      redirect back). So we build a hidden `<form method="POST">`, put the
 *      JSON-stringified manifest in one hidden input, and `submit()` it, which
 *      navigates the whole tab to github.com. The public callback/setup routes
 *      finish the flow server-side and 302 back.
 *
 *   2. The App list — owner, slug, installation COUNT, and a link to the App on
 *      GitHub. Never a secret: the browser API projects metadata only.
 *
 * No spinner (Lume §7.3): the create button carries its in-flight state via
 * `Button busy`.
 */

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; apps: DevGithubAppSummary[] }
  | { kind: 'error'; code: 'unauthorized' | 'generic' };

const thCls =
  'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--fg-muted)]';
const tdCls = 'px-2 py-2 text-sm align-top';
const inputCls =
  'rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

/**
 * GitHub's create-App-from-manifest requires a browser form POST (a fetch will
 * not do — GitHub renders an approval page and redirects). Build it in the DOM,
 * submit, and let the whole tab navigate to `action`.
 */
function submitManifestForm(action: string, manifest: Record<string, unknown>): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  form.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export function GithubAppsPanel(): React.ReactElement {
  const t = useTranslations('adminDevPlatform.apps');
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [org, setOrg] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);

  const load = useCallback(() => {
    void listGithubApps().then(
      (res) => setState({ kind: 'ready', apps: res.apps }),
      (err) =>
        setState({
          kind: 'error',
          code: err instanceof ApiError && (err.status === 401 || err.status === 403) ? 'unauthorized' : 'generic',
        }),
    );
  }, []);

  useEffect(load, [load]);

  const create = useCallback(() => {
    setCreating(true);
    setCreateError(false);
    void (async () => {
      try {
        const { action, manifest } = await startGithubAppManifest(org);
        // Navigates the tab away to github.com — no further React state needed.
        submitManifestForm(action, manifest);
      } catch {
        setCreateError(true);
        setCreating(false);
      }
    })();
  }, [org]);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[color:var(--border)] p-4">
        <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">{t('createHeading')}</h2>
        <p className="mt-1 max-w-2xl text-xs text-[color:var(--fg-muted)]">{t('createBody')}</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[color:var(--fg-muted)]">{t('orgLabel')}</span>
            <input
              className={inputCls}
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder={t('orgPlaceholder')}
              autoComplete="off"
            />
          </label>
          <Button variant="primary" busy={creating} busyLabel={t('creating')} onClick={create}>
            {t('create')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-[color:var(--fg-subtle)]">{t('orgHelp')}</p>
        {createError ? <p className="mt-2 text-sm text-[color:var(--danger)]">{t('createError')}</p> : null}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[color:var(--fg-strong)]">{t('listHeading')}</h2>
        {state.kind === 'loading' ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
        ) : state.kind === 'error' ? (
          state.code === 'unauthorized' ? (
            <p className="text-sm text-[color:var(--fg-muted)]">{t('unauthorized')}</p>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm text-[color:var(--danger)]">{t('loadError')}</span>
              <Button size="sm" variant="secondary" onClick={load}>
                {t('retry')}
              </Button>
            </div>
          )
        ) : state.apps.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40">
            <table className="w-full min-w-max border-collapse">
              <thead>
                <tr className="border-b border-[color:var(--border)]">
                  <th className={thCls}>{t('colOwner')}</th>
                  <th className={thCls}>{t('colSlug')}</th>
                  <th className={thCls}>{t('colInstalls')}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {state.apps.map((app) => (
                  <tr key={app.appId} className="border-b border-[color:var(--border)]/60">
                    <td className={`${tdCls} text-[color:var(--fg-strong)]`}>{app.ownerLogin}</td>
                    <td className={`${tdCls} font-mono text-xs`}>{app.slug}</td>
                    <td className={tdCls}>{t('installs', { count: app.installations })}</td>
                    <td className={tdCls}>
                      <div className="flex justify-end">
                        <a
                          href={app.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-[color:var(--accent)] underline"
                        >
                          {t('openOnGithub')}
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
