'use client';

import { useCallback, useState } from 'react';

import { useTranslations } from 'next-intl';

import { DeviceFlowPanel } from './DeviceFlowPanel';

/**
 * Epic #470 W0 — the credentials step of the add-repo wizard (UI spec §3).
 * Three radio-cards; the selected one gets an accent edge + `.lume-selected`
 * (the spec-sanctioned selection recipe — edge/glow, no state fill). GitHub App
 * is W2, disabled here. The device-flow card renders the honest trade-off block
 * — an `--warning`-left-edge plain-language statement — BEFORE the mode can be
 * confirmed. PAT is a manual password paste.
 */

export type CredentialChoice =
  | { kind: 'github_app' }
  | { kind: 'device_flow'; authorized: boolean; login: string | null }
  | { kind: 'pat'; token: string };

type Mode = 'github_app' | 'device_flow' | 'pat';

const CARD_BASE = 'block cursor-pointer rounded-lg border p-4 text-left transition-colors';

export function CredentialStep({
  onChange,
}: {
  onChange: (choice: CredentialChoice) => void;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.wizard.credentials');
  const [mode, setMode] = useState<Mode | null>(null);
  const [patToken, setPatToken] = useState('');

  const select = useCallback(
    (next: Mode) => {
      setMode(next);
      if (next === 'github_app') onChange({ kind: 'github_app' });
      if (next === 'device_flow') onChange({ kind: 'device_flow', authorized: false, login: null });
      if (next === 'pat') onChange({ kind: 'pat', token: patToken });
    },
    [onChange, patToken],
  );

  const cardClass = (m: Mode, disabled = false): string => {
    const selected = mode === m;
    return `${CARD_BASE} ${
      selected
        ? 'border-[color:var(--accent)] lume-selected'
        : 'border-[color:var(--border)] hover:border-[color:var(--border-strong)]'
    } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`;
  };

  return (
    <div role="radiogroup" aria-label={t('groupLabel')} className="flex flex-col gap-3">
      {/* GitHub App — recommended (W2, disabled here) */}
      <div
        role="radio"
        aria-checked={false}
        aria-disabled
        className={cardClass('github_app', true)}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-[color:var(--fg-strong)]">{t('githubApp.title')}</span>
          <span className="text-xs text-[color:var(--fg-subtle)]">{t('githubApp.soon')}</span>
        </div>
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('githubApp.body')}</p>
      </div>

      {/* Device flow — quick start */}
      <div
        role="radio"
        aria-checked={mode === 'device_flow'}
        tabIndex={0}
        onClick={() => select('device_flow')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select('device_flow');
          }
        }}
        className={cardClass('device_flow')}
      >
        <span className="text-sm font-semibold text-[color:var(--fg-strong)]">{t('deviceFlow.title')}</span>
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('deviceFlow.body')}</p>
        {mode === 'device_flow' ? (
          <>
            <div className="mt-3 border-l-2 border-l-[color:var(--warning)] pl-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--warning)]">
                {t('deviceTradeoffs.heading')}
              </h4>
              <ul className="mt-1 list-disc pl-4 text-xs text-[color:var(--fg)]">
                <li>{t('deviceTradeoffs.asUser')}</li>
                <li>{t('deviceTradeoffs.repoWide')}</li>
                <li>{t('deviceTradeoffs.canMerge')}</li>
                <li>{t('deviceTradeoffs.noWebhooks')}</li>
              </ul>
            </div>
            <DeviceFlowPanel
              onAuthorized={(login) => onChange({ kind: 'device_flow', authorized: true, login })}
            />
          </>
        ) : null}
      </div>

      {/* Fine-grained PAT / deploy key */}
      <div
        role="radio"
        aria-checked={mode === 'pat'}
        tabIndex={0}
        onClick={() => select('pat')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            select('pat');
          }
        }}
        className={cardClass('pat')}
      >
        <span className="text-sm font-semibold text-[color:var(--fg-strong)]">{t('pat.title')}</span>
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('pat.body')}</p>
        {mode === 'pat' ? (
          <label className="mt-3 flex flex-col gap-1 text-xs" onClick={(e) => e.stopPropagation()}>
            <span className="text-[color:var(--fg-muted)]">{t('pat.label')}</span>
            <input
              type="password"
              value={patToken}
              autoComplete="off"
              placeholder={t('pat.placeholder')}
              onChange={(e) => {
                setPatToken(e.target.value);
                onChange({ kind: 'pat', token: e.target.value });
              }}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
        ) : null}
      </div>
    </div>
  );
}
