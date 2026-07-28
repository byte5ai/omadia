'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  bindGithubAppCredential,
  devPlatformErrorCode,
  listGithubApps,
  type DevGithubAppSummary,
} from '../_lib/api';

/**
 * Epic #470 W2 — bind an existing repo to a `github_app` credential (UI spec §2,
 * "repo credential step"). This is the W2 upgrade path for a repo onboarded in
 * W0 with a device-flow or PAT credential: pick the GitHub App path and supply
 * the installation that covers this repo. The middleware proves the installation
 * actually covers the repo before it persists anything (a wrong id is a 400,
 * never a silent bind), and returns branch-protection `warnings` we surface.
 *
 * Why an installation id INPUT and not a picker: the browser API exposes the
 * App registry and each App's installation COUNT, but not the installation ids
 * (those are minted by GitHub during install and returned to the post-install
 * `setup` redirect). So the operator installs the App, then pastes the id GitHub
 * showed — the App list below links straight to each App to install/inspect.
 *
 * No spinner (Lume §7.3): the bind button carries `busy`.
 */

const inputCls =
  'rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

const ERROR_CODE_KEYS: Record<string, string> = {
  'devplatform.installation_not_covering': 'notCovering',
  'devplatform.unknown_installation': 'unknownInstallation',
  'devplatform.invalid_installation': 'invalidInstallation',
  'devplatform.app_unusable': 'appUnusable',
};

export function BindGithubAppPanel({
  repoId,
  onBound,
}: {
  repoId: string;
  onBound: () => void;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.bindApp');
  const [apps, setApps] = useState<DevGithubAppSummary[] | null>(null);
  const [installationId, setInstallationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    void listGithubApps().then(
      (res) => {
        if (alive) setApps(res.apps);
      },
      () => {
        if (alive) setApps([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const bind = useCallback(() => {
    setBusy(true);
    setErrorKey(null);
    setWarnings(null);
    void (async () => {
      try {
        const res = await bindGithubAppCredential(repoId, installationId);
        setWarnings(res.warnings);
        onBound();
      } catch (err) {
        const code = devPlatformErrorCode(err);
        setErrorKey((code && ERROR_CODE_KEYS[code]) ?? 'generic');
      } finally {
        setBusy(false);
      }
    })();
  }, [installationId, onBound, repoId]);

  const ready = installationId.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-xs text-[color:var(--fg-muted)]">{t('intro')}</p>

      {apps === null ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loadingApps')}</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('noApps')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {apps.map((app) => (
            <li key={app.appId} className="flex items-center gap-2">
              <span className="font-mono text-[color:var(--fg)]">{app.ownerLogin}/{app.slug}</span>
              <a
                href={app.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[color:var(--accent)] underline"
              >
                {t('installLink')}
              </a>
            </li>
          ))}
        </ul>
      )}

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[color:var(--fg-muted)]">{t('installationLabel')}</span>
        <input
          className={inputCls}
          value={installationId}
          onChange={(e) => setInstallationId(e.target.value)}
          placeholder={t('installationPlaceholder')}
          inputMode="numeric"
          autoComplete="off"
        />
        <span className="text-[color:var(--fg-subtle)]">{t('installationHelp')}</span>
      </label>

      {warnings !== null ? (
        warnings.length > 0 ? (
          <div className="border-l-2 border-l-[color:var(--warning)] pl-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--warning)]">
              {t('boundWithWarnings')}
            </h4>
            <ul className="mt-1 list-disc pl-4 text-xs text-[color:var(--fg)]">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-[color:var(--success)]">{t('bound')}</p>
        )
      ) : null}

      {errorKey ? <p className="text-sm text-[color:var(--danger)]">{t(`errors.${errorKey}`)}</p> : null}

      <div className="flex justify-end">
        <Button variant="primary" size="sm" busy={busy} busyLabel={t('binding')} disabled={!ready} onClick={bind}>
          {t('bind')}
        </Button>
      </div>
    </div>
  );
}
