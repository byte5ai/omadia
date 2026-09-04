'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  getEmbeddingProvider,
  getLocalEmbeddingModel,
  startLocalEmbeddingModelFetch,
  switchEmbeddingProvider,
  type EmbeddingGateState,
  type EmbeddingProviderOption,
  type EmbeddingProviderState,
  type LocalEmbeddingModelState,
} from '../../_lib/api';

/**
 * Admin → Embeddings · Provider.
 *
 * Picks which `embeddingClient@1` adapter is active. Deliberately NOT shaped
 * like `/admin/memory-backend`: that page persists a choice and asks for a
 * restart, this one performs the switch live — the middleware deactivates the
 * outgoing adapter, activates the target and re-runs the knowledge-graph
 * dimension gate in-process.
 *
 * Two things drive the layout:
 *
 *  - The switch is DESTRUCTIVE. Every stored embedding is discarded and
 *    re-earned by the backfill sweep, one paid provider call per row. So the
 *    cost is stated before the action (how many vectors, whether the column
 *    width changes, that re-embedding costs money) and the button stays
 *    disabled until the operator confirms.
 *  - The gate verdict is LIVE, not a boot snapshot: `vectorWritesAllowed`
 *    flips false→true in-process when a stale-vector clear drains. The state
 *    is therefore polled, and `vector-columns-migrated` /
 *    `stale-vector-clear-complete` render as in-progress information rather
 *    than as errors — both arrive WITH writes allowed and mean "the corpus is
 *    being re-earned", not "something broke".
 */

/** Slow enough to be free, fast enough that the false→true flip is visible
 *  without a reload. */
const POLL_INTERVAL_MS = 10_000;
const POLL_INTERVAL_SECONDS = POLL_INTERVAL_MS / 1000;
/** While weights are downloading, 10s of nothing reads as "stuck". */
const DOWNLOAD_POLL_INTERVAL_MS = 2_000;

/** Gate reasons that are progress reports, not failures. Both are published
 *  together with `vectorWritesAllowed: true`. */
const IN_PROGRESS_REASONS = new Set([
  'vector-columns-migrated',
  'stale-vector-clear-complete',
]);
const CLEAR_PENDING_REASON = 'stale-vector-clear-pending';

type Tone = 'ok' | 'info' | 'warn' | 'error';

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: 'border-[color:var(--border)] bg-[color:var(--card)]/40 text-[color:var(--fg-muted)]',
  info: 'border-[color:var(--accent)]/50 bg-[color:var(--accent)]/8 text-[color:var(--accent)]',
  warn: 'border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
  error:
    'border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 text-[color:var(--danger)]',
};

/** A blocked gate is red; a draining clear is amber; a finished migration or
 *  clear is blue-for-information — never red, because nothing is broken. */
function gateTone(gate: EmbeddingGateState): Tone {
  if (gate.reason !== undefined && IN_PROGRESS_REASONS.has(gate.reason)) {
    return 'info';
  }
  if (gate.reason === CLEAR_PENDING_REASON) return 'warn';
  return gate.vectorWritesAllowed ? 'ok' : 'error';
}

/** The middleware's inline error code, when it sent one. */
function errorCodeOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { code?: string };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

export default function EmbeddingProviderPage(): React.ReactElement {
  const t = useTranslations('adminEmbeddingProvider');
  const format = useFormatter();

  const [state, setState] = useState<EmbeddingProviderState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [target, setTarget] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);

  /**
   * OM-84 follow-up — the keyless adapter's weights. `null` means that adapter
   * is not active (the middleware answers 404), which is the normal state on a
   * keyed deployment and must render nothing at all.
   */
  const [localModel, setLocalModel] = useState<LocalEmbeddingModelState | null>(
    null,
  );
  const [fetchStarting, setFetchStarting] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  /** Silent re-read used by both the mount fetch and the poll. Never toggles
   *  `loading`, so a poll cannot make the page flash. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await getEmbeddingProvider());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    // Settled separately and deliberately not inside the try above: a keyed
    // deployment has no keyless adapter, and letting its absence blank the
    // whole page would be a regression for every install that will never use
    // it.
    try {
      setLocalModel(await getLocalEmbeddingModel());
    } catch {
      setLocalModel(null);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: `loading` already starts true, so the only synchronous
    // state write here is the one that ends it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const downloading = localModel?.job.state === 'running';

  useEffect(() => {
    const timer = setInterval(
      () => void refresh(),
      downloading ? DOWNLOAD_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [refresh, downloading]);

  const onFetchWeights = useCallback(async (): Promise<void> => {
    setFetchStarting(true);
    setFetchError(null);
    try {
      const result = await startLocalEmbeddingModelFetch();
      setLocalModel(result);
    } catch (err) {
      // A 409 means someone else already started it — not an error worth
      // shouting about, so re-read and let the progress row speak.
      if (err instanceof ApiError && err.status === 409) {
        await refresh();
      } else {
        setFetchError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setFetchStarting(false);
    }
  }, [refresh]);

  const candidates = useMemo(
    () => state?.providers.filter((p) => !p.active) ?? [],
    [state],
  );

  const onSwitch = useCallback(async (): Promise<void> => {
    if (target === null) return;
    setSwitching(true);
    setSwitchError(null);
    setSwitchedTo(null);
    try {
      const result = await switchEmbeddingProvider(target, true);
      setState(result);
      setSwitchedTo(result.switchedTo);
      setTarget(null);
      setConfirmed(false);
    } catch (err) {
      const code = errorCodeOf(err);
      if (code === 'embeddingProvider.confirmation_required') {
        setSwitchError(t('confirmationRequiredError'));
      } else if (code === 'embeddingProvider.unknown_target') {
        setSwitchError(t('unknownTargetError'));
      } else if (code === 'embeddingProvider.already_active') {
        setSwitchError(t('alreadyActiveError'));
      } else if (code === 'embeddingProvider.target_unavailable') {
        setSwitchError(t('targetUnavailableError'));
      } else if (err instanceof ApiError && err.status === 403) {
        setSwitchError(t('forbiddenError'));
      } else {
        setSwitchError(err instanceof Error ? err.message : String(err));
      }
      await refresh();
    } finally {
      setSwitching(false);
    }
  }, [refresh, t, target]);

  const dimensions = (value: number | null): string =>
    value === null ? t('unknown') : t('dimensionsValue', { dimensions: value });

  /** What a switch to this provider does to the column width. */
  const widthChangeLabel = (provider: EmbeddingProviderOption): string => {
    const change = provider.preview?.widthChange ?? null;
    if (change === null) return t('widthChangeUnknown');
    if (!change) return t('widthChangeNo');
    return t('widthChangeYes', {
      from: state?.columnDimensions ?? 0,
      to: provider.dimensions ?? 0,
    });
  };

  const dt = 'text-[color:var(--fg-muted)]';
  const card =
    'mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';
  const heading =
    'mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]';

  return (
    <main className="mx-auto max-w-[800px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t.rich('intro', {
            strong: (chunks) => <strong>{chunks}</strong>,
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </header>

      {loading && (
        <section className={`${card} text-sm text-[color:var(--fg-muted)]`}>
          {t('loading')}
        </section>
      )}

      {loadError !== null && (
        <section className={`mb-6 rounded-lg border p-4 text-sm ${TONE_CLASS.error}`}>
          {t('loadFailed', { message: loadError })}
        </section>
      )}

      {state !== null && !loading && (
        <>
          <section className={card}>
            <h2 className={heading}>{t('currentStateTitle')}</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className={dt}>{t('activeProvider')}</dt>
              <dd className="font-mono">{state.activeProviderId ?? t('none')}</dd>
              <dt className={dt}>{t('activeModel')}</dt>
              <dd className="font-mono">
                {state.activeModel?.modelId ?? t('none')}
              </dd>
              <dt className={dt}>{t('activeDimensions')}</dt>
              <dd className="font-mono">
                {dimensions(state.activeModel?.dimensions ?? null)}
              </dd>
              <dt className={dt}>{t('autoMigrateTitle')}</dt>
              <dd>
                {state.autoMigrateVectorColumns
                  ? t('autoMigrateOn')
                  : t('autoMigrateOff')}
              </dd>
            </dl>
            <p className="mt-3 text-xs text-[color:var(--fg-muted)]">
              {t('autoMigrateHint')}
            </p>
            <p className="mt-1 text-xs text-[color:var(--fg-muted)]">
              {t('pollingNote', { seconds: POLL_INTERVAL_SECONDS })}
            </p>
          </section>

          {/* OM-84 follow-up — the keyless adapter is active but its weights
              are not on disk, so it publishes nothing. Printing
              "npm run fetch-model" here would be useless to the person this
              adapter exists for: a subscription user in the desktop app, who
              has no terminal in the flow. So the page drives the download.
              Rendered only when that adapter is active — `localModel` is null
              on every keyed deployment. */}
          {localModel !== null && localModel.missingFiles.length > 0 && (
            <section
              data-testid="local-model-card"
              className={`mb-6 rounded-lg border p-4 text-sm ${TONE_CLASS.info}`}
            >
              <p className="font-semibold">{t('localModelTitle')}</p>
              <p className="mt-1">
                {t('localModelBody', {
                  size: format.number(
                    Math.round(localModel.totalBytes / 1024 / 1024),
                  ),
                })}
              </p>
              <p className="mt-1 font-mono text-xs opacity-80">
                {localModel.modelDir}
              </p>

              {localModel.job.state === 'running' ? (
                <p data-testid="local-model-progress" className="mt-3">
                  {t('localModelProgress', {
                    done: format.number(
                      Math.round(localModel.job.downloadedBytes / 1024 / 1024),
                    ),
                    total: format.number(
                      Math.round(localModel.job.totalBytes / 1024 / 1024),
                    ),
                    file: localModel.job.currentFile ?? '—',
                  })}
                </p>
              ) : (
                <div className="mt-3">
                  <Button
                    type="button"
                    onClick={() => void onFetchWeights()}
                    disabled={fetchStarting}
                    data-testid="local-model-fetch"
                  >
                    {fetchStarting
                      ? t('localModelStarting')
                      : t('localModelFetch')}
                  </Button>
                </div>
              )}

              {localModel.job.state === 'failed' && localModel.job.error !== null && (
                <p
                  data-testid="local-model-error"
                  className="mt-3 text-[color:var(--danger)]"
                >
                  {t('localModelFailed', { message: localModel.job.error })}
                </p>
              )}
              {fetchError !== null && (
                <p className="mt-3 text-[color:var(--danger)]">
                  {t('localModelFailed', { message: fetchError })}
                </p>
              )}

              {/* The threshold is the one thing an operator cannot infer and
                  will not notice: at the knowledge-graph default of 0.90 this
                  model's dedup never fires, silently. */}
              <p className="mt-3 text-xs opacity-80">{t('localModelThreshold')}</p>
            </section>
          )}

          {/* Weights arrived while the page was open. The adapter picks them up
              on its next activation, not retroactively, so say so rather than
              letting the operator wait for a state that will not change. */}
          {localModel !== null &&
            localModel.missingFiles.length === 0 &&
            localModel.job.state === 'done' && (
              <section
                data-testid="local-model-ready"
                className={`mb-6 rounded-lg border p-4 text-sm ${TONE_CLASS.ok}`}
              >
                {t('localModelReady')}
              </section>
            )}

          {state.activeProviderId !== null && !state.capabilityPublished && (
            <section className={`mb-6 rounded-lg border p-4 text-sm ${TONE_CLASS.error}`}>
              {t('capabilityMissing')}
            </section>
          )}

          {/* The registry's client and the governing verdict name different
              models. Amber, not red: an adapter swapped through the generic
              plugin-install UI does not re-gate — deliberately — so nothing
              failed, but the graph is running under a verdict about a model
              nobody is using. Both numbers were already on this page; only
              their disagreement was silent. */}
          {state.providerDrift != null && (
            <section
              className={`mb-6 rounded-lg border p-4 text-sm ${TONE_CLASS.warn}`}
            >
              <p className="font-semibold">{t('providerDriftTitle')}</p>
              <p className="mt-1">
                {t('providerDriftBody', {
                  activeModelId: state.providerDrift.activeModelId,
                  gateModelId: state.providerDrift.gateModelId,
                })}
              </p>
            </section>
          )}

          <GatePanel gate={state.gate} card={card} heading={heading} dt={dt} />

          <section className={card}>
            <h2 className={heading}>{t('corpusTitle')}</h2>
            {state.corpus === null ? (
              <p className="text-sm text-[color:var(--fg-muted)]">
                {t('corpusNone')}
              </p>
            ) : (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className={dt}>{t('corpusModel')}</dt>
                <dd className="font-mono">{state.corpus.modelId}</dd>
                <dt className={dt}>{t('corpusDimensions')}</dt>
                <dd className="font-mono">{dimensions(state.corpus.dimensions)}</dd>
                <dt className={dt}>{t('storedVectors')}</dt>
                <dd className="font-mono">
                  {state.storedVectorTotal === null
                    ? t('unknown')
                    : format.number(state.storedVectorTotal)}
                </dd>
              </dl>
            )}
            {state.corpus?.clearPending === true && (
              <p className="mt-3 text-sm text-[color:var(--warning)]">
                {t('corpusClearPending')}
              </p>
            )}
            {!state.graphAvailable && (
              <p className="mt-3 text-sm text-[color:var(--fg-muted)]">
                {t('graphUnavailable')}
              </p>
            )}
            {state.corpusError !== null && (
              <p className="mt-3 text-sm text-[color:var(--danger)]">
                {t('corpusReadFailed', { message: state.corpusError })}
              </p>
            )}
            {state.columns.length > 0 && (
              <>
                <h3 className={`mt-4 ${heading}`}>{t('columnsTitle')}</h3>
                <ul className="text-sm">
                  {state.columns.map((c) => (
                    <li key={`${c.table}.${c.column}`} className="font-mono">
                      {c.table}.{c.column} · {dimensions(c.declaredDimensions)} ·{' '}
                      {c.storedVectors === null
                        ? t('unknown')
                        : format.number(c.storedVectors)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className={card}>
            <h2 className={heading}>{t('switchTitle')}</h2>
            {candidates.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">
                {t('noAlternatives')}
              </p>
            ) : (
              <>
                <fieldset>
                  <legend className="sr-only">{t('targetLegend')}</legend>
                  <div className="flex flex-col gap-2">
                    {candidates.map((p) => (
                      <label
                        key={p.pluginId}
                        className="flex flex-col gap-0.5 text-sm text-[color:var(--fg-strong)]"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="embedding-provider"
                            value={p.pluginId}
                            checked={target === p.pluginId}
                            disabled={switching}
                            onChange={() => {
                              setTarget(p.pluginId);
                              setConfirmed(false);
                              setSwitchError(null);
                              setSwitchedTo(null);
                            }}
                          />
                          <span>{p.label}</span>
                          <span className="font-mono text-xs text-[color:var(--fg-muted)]">
                            {p.modelId ?? p.pluginId} ·{' '}
                            {dimensions(p.dimensions)}
                          </span>
                        </span>
                        <span className="pl-6 text-xs text-[color:var(--fg-muted)]">
                          {widthChangeLabel(p)}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                {target !== null && (
                  <div
                    className={`mt-4 rounded-lg border p-4 text-sm ${TONE_CLASS.warn}`}
                  >
                    <p className="font-semibold">{t('discardTitle')}</p>
                    <p className="mt-1">
                      {state.storedVectorTotal === null
                        ? t('discardUnknown')
                        : t('discardCount', { count: state.storedVectorTotal })}
                    </p>
                    <p className="mt-1">{t('costWarning')}</p>
                    <label className="mt-3 flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={switching}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      <span>{t('confirmLabel')}</span>
                    </label>
                  </div>
                )}

                <div className="mt-4 flex items-center justify-end">
                  <Button
                    variant="primary"
                    onClick={() => void onSwitch()}
                    disabled={target === null || !confirmed || switching}
                  >
                    {switching ? t('switching') : t('switchButton')}
                  </Button>
                </div>
              </>
            )}
          </section>

          {switchError !== null && (
            <section className={`mb-6 rounded-lg border p-4 text-sm ${TONE_CLASS.error}`}>
              {switchError}
            </section>
          )}

          {switchedTo !== null && switchError === null && (
            <section className={`mb-6 rounded-lg border p-4 text-sm ${TONE_CLASS.info}`}>
              <p className="font-semibold">
                {t('switchedTitle', { provider: switchedTo })}
              </p>
              <p className="mt-1">{t('switchedHint')}</p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function GatePanel({
  gate,
  card,
  heading,
  dt,
}: {
  gate: EmbeddingGateState | null;
  card: string;
  heading: string;
  dt: string;
}): React.ReactElement {
  const t = useTranslations('adminEmbeddingProvider');
  if (gate === null) {
    return (
      <section className={card}>
        <h2 className={heading}>{t('gateTitle')}</h2>
        <p className="text-sm text-[color:var(--fg-muted)]">
          {t('gateUnavailable')}
        </p>
      </section>
    );
  }
  const tone = gateTone(gate);
  return (
    <section className={`mb-6 rounded-lg border p-4 ${TONE_CLASS[tone]}`}>
      <h2 className={heading}>{t('gateTitle')}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className={dt}>{t('gateWrites')}</dt>
        <dd>
          {gate.vectorWritesAllowed
            ? t('gateWritesAllowed')
            : t('gateWritesBlocked')}
        </dd>
        <dt className={dt}>{t('gateStatus')}</dt>
        <dd className="font-mono">{gate.status}</dd>
        {gate.reason !== undefined && (
          <>
            <dt className={dt}>{t('gateReason')}</dt>
            <dd className="font-mono">{gate.reason}</dd>
          </>
        )}
        {gate.detail !== undefined && (
          <>
            <dt className={dt}>{t('gateDetail')}</dt>
            <dd>{gate.detail}</dd>
          </>
        )}
      </dl>
      {gate.reason === 'vector-columns-migrated' && (
        <p className="mt-3 text-sm">{t('gateMigrating')}</p>
      )}
      {gate.reason === 'stale-vector-clear-complete' && (
        <p className="mt-3 text-sm">{t('gateClearComplete')}</p>
      )}
      {gate.reason === CLEAR_PENDING_REASON && (
        <p className="mt-3 text-sm">{t('gateClearPending')}</p>
      )}
    </section>
  );
}
