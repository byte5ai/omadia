'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ErrorHelp } from '@/app/_components/ErrorHelp';
import {
  compareProviders,
  ConnectionChip,
  errorCode,
  SaveError,
  StatusChip,
  type SaveStatus,
} from '@/app/admin/_components/providerCredential';
import {
  getTranscriptionProviderState,
  selectTranscriptionProvider,
  setTranscriptionProviderKey,
  verifyTranscriptionProvider,
  type TranscriptionProvider,
  type TranscriptionProviderState,
} from '../../../_lib/api';

/**
 * Transcription provider admin (#584) — the transcription twin of the
 * LLM `ProvidersPanel`: provider rows with the 4-state credential chip and
 * inline key entry, plus single-active-provider selection (the
 * embedding-provider model: activating one adapter deactivates the previous).
 * The AVV / Art. 28 disclosure and the EU-hosting note render on the ACTIVE
 * provider, driven by the manifest `policy` — data-driven, no id checks.
 *
 * Unlike the LLM page, the key is saved through the dedicated
 * `/transcription-provider/:id/key` endpoint (it lives in the adapter
 * plugin's own vault scope), not the settings catalog.
 *
 * The chip/key-entry building blocks and their copy are shared with the LLM
 * page (`app/admin/_components/providerCredential.tsx`, `adminProviders.*`
 * namespace); only genuinely transcription-specific copy lives under
 * `adminTranscriptionProvider.*`.
 */

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: TranscriptionProviderState }
  // The thrown error itself, not a pre-flattened string: the component decides
  // what is headline and what is disclosed detail, not the state.
  | { kind: 'error'; error: unknown };

export function TranscriptionProviderPanel(): React.ReactElement {
  const t = useTranslations('adminTranscriptionProvider');
  const tShared = useTranslations('adminProviders');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<unknown>(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await getTranscriptionProviderState();
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({ kind: 'error', error: err });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activate = useCallback(
    async (providerId: string): Promise<void> => {
      setSwitching(true);
      setSwitchError(undefined);
      try {
        await selectTranscriptionProvider(providerId);
      } catch (err) {
        setSwitchError(err);
      } finally {
        await load();
        setSwitching(false);
      }
    },
    [load],
  );

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{tShared('loading')}</p>
      ) : state.kind === 'error' ? (
        <ErrorHelp
          code={errorCode(state.error)}
          rawDetail={state.error}
          fallback={t('loadError')}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {!state.data.vault_available && (
            <p className="rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-4 py-3 text-sm text-[color:var(--warning)]">
              {tShared('vaultUnavailable')}
            </p>
          )}

          {state.data.providers.length === 0 ? (
            <p className="text-sm text-[color:var(--fg-muted)]">
              {t('noProviders')}
            </p>
          ) : (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
                {tShared('providers.heading')}
              </h2>
              {state.data.active === null && (
                <p className="mb-3 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-[12px] leading-[1.5] text-[color:var(--warning)]">
                  {t('selection.noneActive')}
                </p>
              )}
              <ul className="flex flex-col gap-3">
                {[...state.data.providers].sort(compareProviders).map((p) => (
                  <ProviderRow
                    key={p.id}
                    provider={p}
                    onReload={load}
                    switching={switching}
                    onActivate={activate}
                  />
                ))}
              </ul>
              {switchError !== undefined && (
                <div className="mt-3">
                  <ErrorHelp code={errorCode(switchError)} rawDetail={switchError} />
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </main>
  );
}

function ProviderRow({
  provider: p,
  onReload,
  switching,
  onActivate,
}: {
  provider: TranscriptionProvider;
  /** Re-fetch the provider list after a key save so the chip updates. */
  onReload: () => Promise<void>;
  /** A provider switch is in flight anywhere on the page. */
  switching: boolean;
  onActivate: (providerId: string) => void;
}): React.ReactElement {
  const t = useTranslations('adminTranscriptionProvider');
  const tShared = useTranslations('adminProviders');
  const [editing, setEditing] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [verifying, setVerifying] = useState(false);
  const inputId = `transcription-key-${p.id}`;

  /** Probe the stored key and refresh the row. Swallowing a failure here is
   *  deliberate: an unreachable probe leaves the status at `unverified`, which
   *  is exactly the honest outcome — it must never be reported as a bad key. */
  const runVerify = async (): Promise<void> => {
    setVerifying(true);
    try {
      await verifyTranscriptionProvider(p.id);
      await onReload();
    } catch {
      await onReload();
    } finally {
      setVerifying(false);
    }
  };

  const saveKey = async (): Promise<void> => {
    const value = keyValue.trim();
    if (value.length === 0) return;
    setSaveStatus('saving');
    setSaveError(undefined);
    try {
      await setTranscriptionProviderKey(p.id, value);
      setSaveStatus('saved');
      setKeyValue('');
      setEditing(false);
      // Probe the key the operator just pasted BEFORE reloading, so the row
      // never flashes a stale verdict — and so a typo is caught here rather
      // than surfacing later as an unexplained tool failure.
      await runVerify();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err);
    }
  };

  const removeKey = async (): Promise<void> => {
    if (saveStatus === 'saving') return;
    if (!confirm(t('providers.removeKeyConfirm', { provider: p.label }))) return;
    setSaveStatus('saving');
    setSaveError(undefined);
    try {
      await setTranscriptionProviderKey(p.id, null);
      setSaveStatus('saved');
      await onReload();
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err);
    }
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
            {p.label}
          </span>
          <code className="text-[11px] text-[color:var(--fg-muted)]">{p.id}</code>
          <span className="text-[11px] text-[color:var(--fg-muted)]">
            {tShared('providers.modelCount', { count: p.models.length })}
          </span>
          {p.active && (
            <span className="rounded-full border border-[color:var(--accent)]/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[color:var(--accent)]">
              {t('selection.activeBadge')}
            </span>
          )}
        </span>
        <span className="flex items-center gap-3">
          <ConnectionChip provider={p} />
          {/* Explicit re-probe — only offered when a credential exists. */}
          {p.status !== 'no_key' && (
            // eslint-disable-next-line no-restricted-syntax -- inline text link (bare accent text, no border/bg)
            <button
              type="button"
              onClick={() => void runVerify()}
              disabled={verifying || saveStatus === 'saving'}
              className="text-[13px] font-medium text-[color:var(--accent)] disabled:opacity-50"
            >
              {verifying ? tShared('providers.testing') : tShared('providers.testKey')}
            </button>
          )}
          {!editing &&
            (p.connected ? (
              <span className="flex items-center gap-3">
                {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare accent text, no border/bg) */}
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={saveStatus === 'saving'}
                  className="text-[13px] font-medium text-[color:var(--accent)] disabled:opacity-50"
                >
                  {tShared('providers.changeKey')} →
                </button>
                {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare danger text, no border/bg) */}
                <button
                  type="button"
                  onClick={() => void removeKey()}
                  disabled={saveStatus === 'saving'}
                  className="text-[13px] font-medium text-[color:var(--danger)] disabled:opacity-50"
                >
                  {tShared('providers.removeKey')}
                </button>
                {saveStatus === 'saving' && <StatusChip status={saveStatus} />}
              </span>
            ) : (
              // eslint-disable-next-line no-restricted-syntax -- inline text link (bare accent text, no border/bg)
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-[13px] font-medium text-[color:var(--accent)]"
              >
                {tShared('providers.addKey')} →
              </button>
            ))}
          {!p.active && (
            <Button
              variant="secondary"
              disabled={switching}
              onClick={() => onActivate(p.id)}
            >
              {switching ? t('selection.activating') : t('selection.activate')}
            </Button>
          )}
        </span>
      </div>

      <p className="text-[12px] text-[color:var(--fg-muted)]">
        {p.models
          .map(
            (m) =>
              `${m.label} — ${m.surfaces
                .map((s) =>
                  s === 'file'
                    ? t('providers.surfaceFile')
                    : t('providers.surfaceStream'),
                )
                .join(', ')}`,
          )
          .join(' · ')}
      </p>

      {editing && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={inputId}>
            {tShared('providers.keyInputLabel', { provider: p.label })}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={inputId}
              type="password"
              autoFocus
              value={keyValue}
              placeholder={tShared('providers.keyPlaceholder')}
              onChange={(e) => {
                setKeyValue(e.target.value);
                setSaveStatus('idle');
                setSaveError(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey();
              }}
              className="flex-1 rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)] disabled:opacity-50 sm:min-w-[260px]"
            />
            <Button
              variant="primary"
              disabled={saveStatus === 'saving' || keyValue.trim().length === 0}
              onClick={() => void saveKey()}
            >
              {tShared('providers.saveKey')}
            </Button>
            <Button
              variant="secondary"
              disabled={saveStatus === 'saving'}
              onClick={() => {
                setEditing(false);
                setKeyValue('');
                setSaveStatus('idle');
                setSaveError(undefined);
              }}
            >
              {tShared('providers.cancel')}
            </Button>
            <StatusChip status={saveStatus} />
          </div>
          <SaveError error={saveError} />
        </div>
      )}

      {/* The explanation for a rejected key — resolved against the localized
          catalogue via the machine code; the middleware's English sentence
          survives only as the fallback. */}
      {p.status === 'invalid' && (p.verifyErrorCode ?? p.verifyError) && (
        <div className="flex flex-col gap-1">
          <ErrorHelp code={p.verifyErrorCode ?? null} fallback={p.verifyError} />
          <a
            href="/help"
            className="text-[12px] underline underline-offset-2 text-[color:var(--accent)]"
          >
            {tShared('providers.helpLink')}
          </a>
        </div>
      )}

      {/* removeKey runs while `editing` is false, so surface its failures here. */}
      {!editing && <SaveError error={saveError} />}

      {/* Data-driven AVV / Art. 28 disclosure for the provider audio actually
          flows to — the ACTIVE one. The server defaults unknown providers to
          requiring the disclosure. */}
      {p.active && p.requiresAvvDisclosure && (
        <p className="rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-[12px] leading-[1.5] text-[color:var(--warning)]">
          {t('selection.avvDisclosure', { provider: p.label })}
        </p>
      )}
      {p.active && p.euHosted && (
        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--border)]/10 px-3 py-2 text-[12px] leading-[1.5] text-[color:var(--fg-muted)]">
          {t('selection.euHostedNote', { provider: p.label })}
        </p>
      )}
    </li>
  );
}
