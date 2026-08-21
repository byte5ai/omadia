'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  getTranscriptionProvider,
  switchTranscriptionProvider,
  type TranscriptionProviderState,
} from '../../_lib/api';

/**
 * Admin → LLM Access · Transcription provider (#584 WS T).
 *
 * The operator surface — and the CONSENT surface — for the `transcription@1`
 * capability: shows which speech-to-text adapters are installed, which one is
 * live, whether it actually publishes a service (an adapter without an API
 * key activates but publishes nothing), and switches providers in-process
 * with verified rollback. The intro names, in front of the switch, that an
 * active provider sends raw meeting/recording audio to the configured
 * external endpoint — the same explicitness the LLM key pages practice.
 *
 * Deliberately lean next to the embedding sibling: a transcription switch
 * destroys no corpus, so there is no discard confirmation and no gate.
 */

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; state: TranscriptionProviderState }
  | { kind: 'error'; message: string };

export default function TranscriptionProviderPage(): React.ReactElement {
  const t = useTranslations('adminTranscriptionProvider');
  const [page, setPage] = useState<PageState>({ kind: 'loading' });
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const req = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++req.current;
    try {
      const state = await getTranscriptionProvider();
      if (req.current !== mine) return;
      setPage({ kind: 'ready', state });
    } catch (err) {
      if (req.current !== mine) return;
      setPage({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSwitch = useCallback(
    async (pluginId: string): Promise<void> => {
      setSwitching(pluginId);
      setSwitchError(null);
      try {
        await switchTranscriptionProvider(pluginId);
        await reload();
      } catch (err) {
        setSwitchError(describeSwitchError(err, t));
        await reload();
      } finally {
        setSwitching(null);
      }
    },
    [reload, t],
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
        {t('intro')}
      </p>
      <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">
        {t('privacyNote')}
      </p>

      {page.kind === 'loading' && (
        <p className="mt-8 text-sm text-neutral-500">{t('loading')}</p>
      )}
      {page.kind === 'error' && (
        <p className="mt-8 text-sm text-red-600">
          {t('loadFailed', { message: page.message })}
        </p>
      )}
      {page.kind === 'ready' && (
        <>
          <section className="mt-8">
            <h2 className="text-lg font-medium">{t('currentStateTitle')}</h2>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-neutral-500">{t('activeProviderLabel')}</dt>
              <dd>
                {page.state.activeProviderId ?? t('noneActive')}
              </dd>
              <dt className="text-neutral-500">{t('publishedLabel')}</dt>
              <dd>
                {page.state.capabilityPublished
                  ? t('publishedYes', {
                      provider: page.state.activeProvider ?? '?',
                    })
                  : t('publishedNo')}
              </dd>
            </dl>
            {page.state.activeProviderId !== null &&
              !page.state.capabilityPublished && (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                  {t('capabilityMissing')}
                </p>
              )}
          </section>

          <section className="mt-8">
            <h2 className="text-lg font-medium">{t('providersTitle')}</h2>
            {page.state.providers.length === 0 && (
              <p className="mt-3 text-sm text-neutral-500">
                {t('noProviders')}
              </p>
            )}
            <ul className="mt-3 space-y-3">
              {page.state.providers.map((p) => (
                <li
                  key={p.pluginId}
                  className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-700"
                >
                  <div>
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="text-xs text-neutral-500">
                      {p.pluginId}
                      {p.active ? ` · ${t('activeBadge')}` : ''}
                    </div>
                  </div>
                  {!p.active && (
                    <Button
                      onClick={() => void onSwitch(p.pluginId)}
                      disabled={switching !== null}
                    >
                      {switching === p.pluginId
                        ? t('switching')
                        : t('switchTo')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {switchError !== null && (
              <p className="mt-3 text-sm text-red-600">{switchError}</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

/** Map the router's error codes onto operator-readable text; anything
 *  unrecognised surfaces verbatim rather than as a generic shrug. */
function describeSwitchError(
  err: unknown,
  t: ReturnType<typeof useTranslations<'adminTranscriptionProvider'>>,
): string {
  if (err instanceof ApiError) {
    if (err.code === 'transcriptionProvider.target_unavailable') {
      return t('switchTargetUnavailable');
    }
    if (err.code === 'transcriptionProvider.switch_in_progress') {
      return t('switchInProgress');
    }
    if (err.code === 'transcriptionProvider.already_active') {
      return t('switchAlreadyActive');
    }
  }
  return t('switchFailed', {
    message: err instanceof Error ? err.message : String(err),
  });
}
