'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import {
  ApiError,
  getUpdateHistory,
  getUpdatePreflight,
  getUpdateReleases,
  getUpdateStatus,
  triggerUpdate,
  type UpdateAuditEntry,
  type UpdatePreflight,
  type UpdateRelease,
  type UpdateStatus,
} from '../../../_lib/api';

import { decodeFailure, deriveOutcome, type InflightUpdate } from './updateFailure';
import { UpdateProgressModal, type PollingInfo } from './UpdateProgressModal';

/**
 * Admin → Update (#432).
 *
 * Reports the running build, whether a newer release exists, and — only when
 * the opt-in updater overlay is deployed — lets the operator pick a published
 * release and move the stack to it.
 *
 * The version is CHOSEN, not implied: the picker lists the published releases
 * newest-first and includes older ones, because rolling back to a known-good
 * build is the most useful thing this page can offer when something is wrong.
 * Whichever version is selected is checked against the registry first, and the
 * per-service verdict is shown before the button is armed — the operator sees
 * "these two images exist" instead of discovering a missing tag mid-update.
 *
 * There is no type-to-confirm box. It was borrowed from the Danger Zone, but
 * an update is version-pinned, health-gated and auto-rolled-back, so retyping
 * the tag added friction without adding a decision the picker does not already
 * make explicit.
 *
 * Two behaviours that are not cosmetic:
 *
 *   - Polling, not awaiting. Applying an update recreates the container that
 *     served the request, so the trigger answers 202 and this page then polls
 *     `/status` through the restart. Errors during that window are expected,
 *     not failures, and are swallowed while an update is in flight — but they
 *     are SHOWN, in the progress dialog, as "middleware not answering", so
 *     the operator sees the restart happening instead of a frozen page.
 *   - The in-flight run survives this page. The web-ui container is replaced
 *     too, so the tab may reload mid-update; the run is remembered in
 *     localStorage and the dialog resumes on the next mount. An update started
 *     from another browser is picked up from the sidecar's `updating` state.
 *   - Honest capability reporting. With no executor configured the page says
 *     so and shows the manual command instead of offering a button that would
 *     answer 409.
 */

/**
 * Idle polling is slow on purpose: every `/status` call also settles open audit
 * rows (two UPDATEs) and pings the sidecar, and a version number does not
 * change while nobody is updating. The fast cadence is only for the window
 * where the middleware is being replaced and the page has to notice it return.
 */
const IDLE_POLL_MS = 30_000;
const ACTIVE_POLL_MS = 4_000;

/** localStorage key for the run this browser is watching. */
const INFLIGHT_KEY = 'omadia.adminUpdate.inflight';
/** A remembered run older than this is a leftover (tab closed mid-update,
 *  sidecar restarted since) and is dropped on read instead of resuming as an
 *  instantly-stalled dialog. Comfortably above the sidecar's 5 min gate plus
 *  pull and rollback time. */
const INFLIGHT_TTL_MS = 60 * 60_000;

function readInflight(): InflightUpdate | null {
  try {
    const raw = window.localStorage.getItem(INFLIGHT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as InflightUpdate).target === 'string' &&
      typeof (parsed as InflightUpdate).startedAt === 'number'
    ) {
      const p = parsed as InflightUpdate;
      if (Date.now() - p.startedAt > INFLIGHT_TTL_MS) {
        window.localStorage.removeItem(INFLIGHT_KEY);
        return null;
      }
      return { target: p.target, previous: p.previous ?? null, startedAt: p.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function writeInflight(value: InflightUpdate | null): void {
  try {
    if (value === null) window.localStorage.removeItem(INFLIGHT_KEY);
    else window.localStorage.setItem(INFLIGHT_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, quota); the dialog then just
    // does not survive a reload, which is a degradation, not a failure.
  }
}

/** Error codes the backend returns for a refused trigger. Anything else falls
 *  back to the generic message with the technical detail behind it. */
const KNOWN_ERRORS = new Set([
  'invalid_target_version',
  'updater_not_configured',
  'audit_unavailable',
  'update_in_progress',
  'already_on_target',
  'updater_unreachable',
  'updater_rejected',
  'audit_write_failed',
]);

export interface UpdateClientProps {
  /** Fly app name of the WEB-UI app, supplied by the server shell. Absent on
   *  compose / local, where the generic instructions apply. */
  readonly webUiApp?: string;
}

export function UpdateClient({ webUiApp }: UpdateClientProps): React.ReactElement {
  const t = useTranslations('adminUpdate');

  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateAuditEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The version the operator picked. Empty until the release list (or, if
  // GitHub is unreachable, the last known release) supplies a default.
  const [selected, setSelected] = useState('');
  const [releases, setReleases] = useState<UpdateRelease[]>([]);
  const [releasesFailed, setReleasesFailed] = useState(false);

  /** `unsupported` and `error` are NOT "image missing" — an old sidecar or a
   *  failed check must never be rendered as a bad tag, or the operator gets
   *  talked out of a perfectly good update. Only `failed` blocks the button. */
  const [checkState, setCheckState] = useState<
    'idle' | 'checking' | 'ok' | 'failed' | 'unsupported' | 'error'
  >('idle');
  const [preflight, setPreflight] = useState<UpdatePreflight | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  // The run this browser is watching; null when no dialog is open. Restored
  // from localStorage on mount so a tab reload mid-update resumes the dialog.
  const [inflight, setInflight] = useState<InflightUpdate | null>(null);
  const [polling, setPolling] = useState<Omit<PollingInfo, 'intervalMs'>>({
    lastAttemptAt: null,
    lastOkAt: null,
    attempts: 0,
  });

  useEffect(() => {
    const remembered = readInflight();
    if (remembered !== null) setInflight(remembered);
  }, []);

  // The run the operator dismissed from the stalled state. Until the sidecar
  // reports something else, its `updating` snapshot is still in `status`, and
  // without this marker the adoption effect below would reopen the dialog on
  // the very next render. Keyed on the sidecar's own startedAt so a genuinely
  // new job for the same target is still adopted.
  const dismissedRef = useRef<{ target: string; startedAt: string | null } | null>(null);

  // Read inside the interval callback without making it a dependency — the
  // poll must not be torn down and rebuilt on every status change. Mirrored in
  // an effect rather than assigned during render (refs are not render state).
  const awaitingRef = useRef(false);
  const awaitingRestart = inflight !== null;
  useEffect(() => {
    awaitingRef.current = awaitingRestart;
  }, [awaitingRestart]);

  const load = useCallback(async (refresh = false): Promise<void> => {
    const attemptAt = Date.now();
    let okAt: number | null = null;
    try {
      const next = await getUpdateStatus(refresh);
      okAt = Date.now();
      setStatus(next);
      setLoadError(null);
      if (next.auditAvailable) {
        const trail = await getUpdateHistory();
        setHistory(trail.entries);
      }
    } catch (err) {
      // While the stack is restarting the middleware is legitimately gone;
      // surfacing that as an error would make a working update look broken.
      // The dialog shows the gap as "not answering" from the polling info.
      if (!awaitingRef.current) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Bookkeeping for the dialog's polling indicator: every attempt counts,
      // and a failed one leaves `lastOkAt` where it was, so "last answer N s
      // ago" keeps growing while the middleware is down.
      setPolling((p) => ({
        lastAttemptAt: attemptAt,
        attempts: p.attempts + 1,
        lastOkAt: okAt ?? p.lastOkAt,
      }));
    }
  }, []);

  const active = awaitingRestart || status?.executor.state === 'updating';

  // An update started elsewhere (another tab, another admin, or this tab
  // before a reload that lost storage) shows up as the sidecar being
  // `updating`; adopt it so the dialog covers that run too.
  useEffect(() => {
    if (inflight !== null || status?.executor.state !== 'updating') return;
    const target = status.executor.targetVersion;
    if (typeof target !== 'string' || target.length === 0) return;
    const dismissed = dismissedRef.current;
    if (
      dismissed !== null &&
      dismissed.target === target &&
      dismissed.startedAt === (status.executor.startedAt ?? null)
    ) {
      return;
    }
    const started = typeof status.executor.startedAt === 'string'
      ? Date.parse(status.executor.startedAt)
      : NaN;
    const adopted: InflightUpdate = {
      target,
      previous: status.executor.previousVersion ?? status.current.version,
      startedAt: Number.isNaN(started) ? Date.now() : started,
    };
    setInflight(adopted);
    writeInflight(adopted);
  }, [inflight, status]);

  const outcome = inflight === null ? 'running' : deriveOutcome(status, inflight);
  const currentVersion = status?.current.version ?? null;

  const closeDialog = useCallback((): void => {
    if (inflight !== null) {
      dismissedRef.current = {
        target: inflight.target,
        startedAt: status?.executor.startedAt ?? null,
      };
    }
    setInflight(null);
    writeInflight(null);
    void load(true);
  }, [inflight, load, status?.executor.startedAt]);

  const reloadPage = useCallback((): void => {
    writeInflight(null);
    window.location.reload();
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(
      () => { void load(); },
      active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    return () => { clearInterval(timer); };
    // `active` is a dependency on purpose: the timer is rebuilt when the page
    // switches cadence, which is the only time the interval should change.
  }, [load, active]);

  const executorReady =
    status?.executor.configured === true && status.executor.reachable;
  const updating = status?.executor.state === 'updating';

  // The release list is only fetched where it can be acted on. On a notify-only
  // instance there is nothing to pick between, and the call would spend GitHub
  // budget to populate a control that is never rendered.
  useEffect(() => {
    if (!executorReady || releases.length > 0 || releasesFailed) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getUpdateReleases();
        if (cancelled) return;
        setReleases(res.releases);
        // An empty list is a failed lookup as far as the picker is concerned:
        // there is nothing to choose from either way, and saying so is more
        // useful than an empty dropdown.
        setReleasesFailed(res.releases.length === 0);
      } catch {
        if (!cancelled) setReleasesFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [executorReady, releases.length, releasesFailed]);

  // The picker defaults to the newest release — from the list if it loaded,
  // otherwise from the single `latest` the status already carries, so the page
  // still works with GitHub's list endpoint unreachable. Derived rather than
  // synced into state: an effect that writes the default would race the load
  // and briefly render a selection the operator never made.
  const latestTag = releases[0]?.tag ?? status?.latest?.tag ?? '';
  const target = selected !== '' ? selected : latestTag;

  // Check the chosen version against the registry. Re-runs on every change of
  // selection; a stale answer for a version the operator has already moved on
  // from would be worse than none, so late responses are dropped.
  useEffect(() => {
    if (!executorReady || target === '') {
      setCheckState('idle');
      setPreflight(null);
      return;
    }
    let cancelled = false;
    setCheckState('checking');
    setPreflight(null);
    setCheckError(null);
    void (async () => {
      try {
        const result = await getUpdatePreflight(target);
        if (cancelled) return;
        setPreflight(result);
        setCheckState(result.ok ? 'ok' : 'failed');
      } catch (err) {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.code : null;
        if (code === 'preflight_unsupported') {
          setCheckState('unsupported');
          return;
        }
        setCheckError(err instanceof Error ? err.message : String(err));
        setCheckState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [executorReady, target]);

  // Fill the manual Fly command in with the operator's ACTUAL app names when
  // we know them: the middleware reports its own via /status, the server shell
  // supplies the web-ui's. A command with `<middleware-app>` in it is a command
  // the operator has to go and look up before they can run it.
  const onFly = status?.platform?.kind === 'fly';
  const flyCommand = useMemo(() => {
    // Falls back to the newest known release, not the picker: this block is
    // rendered on notify-only instances, where nothing is ever selected.
    const version =
      target.length > 0 ? target : (status?.latest?.tag ?? 'vX.Y.Z');
    const mw = status?.platform?.appName ?? '<middleware-app>';
    const ui = webUiApp ?? '<web-ui-app>';
    return [
      // Middleware first: it runs the schema migrations at boot.
      `fly deploy --app ${mw} --config fly/middleware.fly.toml \\`,
      `  --image ghcr.io/byte5ai/omadia-middleware:${version}`,
      `fly deploy --app ${ui} --config fly/web-ui.fly.toml \\`,
      `  --image ghcr.io/byte5ai/omadia-web-ui:${version}`,
    ].join('\n');
  }, [status?.latest?.tag, status?.platform?.appName, target, webUiApp]);

  const currentSource = status?.current.source ?? null;

  /** Tag comparison ignoring a leading `v`, the way the backend canonicalises
   *  it — so a `0.140.1` release next to a `v0.140.1` build is still "same". */
  const isCurrentTag = useCallback(
    (tag: string): boolean =>
      currentVersion !== null &&
      currentSource === 'release' &&
      tag.replace(/^v/, '') === currentVersion.replace(/^v/, ''),
    [currentSource, currentVersion],
  );

  const latestRelease = status?.latest ?? null;

  /** What the picker offers. Falls back to the single `latest` the status
   *  already carries when the list endpoint could not be reached, so the page
   *  degrades to the old one-version behaviour instead of an empty control. */
  const versionOptions = useMemo(() => {
    const source: UpdateRelease[] =
      releases.length > 0 ? releases : latestRelease !== null ? [latestRelease] : [];
    return source.map((release) => ({
      tag: release.tag,
      label: isCurrentTag(release.tag)
        ? t('targetCurrent', { version: release.tag })
        : release.prerelease
          ? t('targetPrerelease', { version: release.tag })
          : release.tag,
    }));
  }, [isCurrentTag, latestRelease, releases, t]);

  const canTrigger =
    executorReady &&
    status?.auditAvailable === true &&
    target.length > 0 &&
    !isCurrentTag(target) &&
    // A version whose images demonstrably are not in the registry cannot
    // succeed; the job would abort in preflight. An unsupported or failed
    // CHECK does not block — that is missing information, not a bad target.
    checkState !== 'failed' &&
    checkState !== 'checking' &&
    !triggering &&
    !updating &&
    !awaitingRestart;

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const onTrigger = useCallback(async (): Promise<void> => {
    if (target.length === 0) return;
    setTriggering(true);
    setTriggerError(null);
    try {
      await triggerUpdate({ targetVersion: target });
      // From here the middleware is expected to disappear and come back on the
      // new image; polling takes over and the dialog shows it.
      const run: InflightUpdate = {
        target,
        previous: currentVersion,
        startedAt: Date.now(),
      };
      setInflight(run);
      writeInflight(run);
      dismissedRef.current = null;
      // Fresh counters for the dialog; both timestamps reset together so the
      // indicator does not read "not answering" for the first tick.
      setPolling({ attempts: 0, lastOkAt: null, lastAttemptAt: null });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setTriggerError(
        code !== null && KNOWN_ERRORS.has(code)
          ? t(`errors.${code}`)
          : t('errors.generic', {
              message: err instanceof Error ? err.message : String(err),
            }),
      );
    } finally {
      setTriggering(false);
    }
  }, [currentVersion, target, t]);

  const rolledBackBanner = useMemo(() => {
    if (status?.executor.state !== 'rolled_back' || awaitingRestart) return null;
    const decoded = decodeFailure(status.executor.failure, status.executor.error);
    const from = status.executor.targetVersion ?? '?';
    const to = status.current.version;
    switch (decoded.kind) {
      case 'never_reachable':
        return t('rolledBackNeverReachable', { from, to });
      case 'version_never_matched':
        return t('rolledBackVersionNeverMatched', { from, to, observed: decoded.observedVersion });
      case 'replace':
        return t('rolledBackReplace', { from, to, service: decoded.service ?? '?' });
      default:
        return t('rolledBack', { message: decoded.message });
    }
  }, [awaitingRestart, status, t]);

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
          {t('intro')}
        </p>
      </header>

      {loadError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('loadError', { message: loadError })}
        </section>
      )}

      <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-3 text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
          {t('versionsTitle')}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[color:var(--fg-muted)]">{t('running')}</dt>
          <dd className="font-mono">
            {status?.current.version ?? '…'}
            {status?.current.source === 'unknown' && (
              <span className="ml-2 font-sans text-xs text-[color:var(--fg-muted)]">
                {t('unstamped')}
              </span>
            )}
            {status?.current.source === 'floating' && (
              <span className="ml-2 font-sans text-xs text-[color:var(--fg-muted)]">
                {t('floating')}
              </span>
            )}
          </dd>
          <dt className="text-[color:var(--fg-muted)]">{t('latest')}</dt>
          <dd className="font-mono">
            {status?.latest === null || status === null ? (
              t('latestUnknown')
            ) : (
              <a
                href={status.latest.url}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted"
              >
                {status.latest.tag}
              </a>
            )}
          </dd>
        </dl>

        {status?.updateAvailable === true && (
          <p className="mt-3 rounded border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-2 text-sm">
            {t('updateAvailable', { version: status.latest?.tag ?? '' })}
          </p>
        )}
        {status !== null && !status.updateAvailable && status.current.source === 'release' && (
          <p className="mt-3 text-sm text-[color:var(--fg-muted)]">{t('upToDate')}</p>
        )}
        {status?.check.stale === true && (
          <p className="mt-3 text-xs text-[color:var(--fg-muted)]">
            {t('checkStale')}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={refreshing}
          >
            {refreshing ? t('checking') : t('checkNow')}
          </Button>
        </div>
      </section>

      {status !== null && !status.executor.configured && (
        <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 text-sm">
          <h2 className="mb-2 text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('notifyOnlyTitle')}
          </h2>
          <p className="text-[color:var(--fg-muted)]">{t('notifyOnlyBody')}</p>
          {/* Labelled per platform: the executor is compose-only, so an
              unlabelled `docker compose` line would be actively misleading on
              a Fly.io or Kubernetes deployment, which reach this same state. */}
          <p className="mt-3 text-[11px] tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('notifyOnlyComposeLabel')}
          </p>
          <pre className="mt-1 overflow-x-auto rounded bg-[color:var(--bg)] p-3 font-mono text-xs">
            {t('notifyOnlyComposeCmd', {
              version: target.length > 0 ? target : 'vX.Y.Z',
            })}
          </pre>
          <p className="mt-3 text-[11px] tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('notifyOnlyFlyLabel')}
          </p>
          <pre className="mt-1 overflow-x-auto rounded bg-[color:var(--bg)] p-3 font-mono text-xs">
            {flyCommand}
          </pre>
          {onFly && (
            <>
              <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
                {t('notifyOnlyFlyOrderHint')}
              </p>
              <p className="mt-1 text-xs text-[color:var(--fg-muted)]">
                {t('notifyOnlyFlyPinHint')}
              </p>
            </>
          )}
          <p className="mt-3 text-xs text-[color:var(--fg-muted)]">
            {t('notifyOnlyDocsHint')}
          </p>
        </section>
      )}

      {status?.executor.configured === true && !status.executor.reachable && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('executorUnreachable', { message: status.executor.error ?? '' })}
        </section>
      )}

      {status?.executor.configured === true && status.auditAvailable === false && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/5 p-4 text-sm text-[color:var(--danger)]">
          {t('auditUnavailable')}
        </section>
      )}

      {inflight !== null && (
        <UpdateProgressModal
          inflight={inflight}
          status={status}
          outcome={outcome}
          polling={{ ...polling, intervalMs: active ? ACTIVE_POLL_MS : IDLE_POLL_MS }}
          onClose={closeDialog}
          onReload={reloadPage}
        />
      )}

      {updating && inflight === null && (
        <section className="mb-6 rounded-lg border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-4 text-sm">
          <h2 className="mb-2 text-[10px] font-semibold tracking-wider uppercase">
            {t('inProgressTitle')}
          </h2>
          <p>{t('inProgressBody')}</p>
        </section>
      )}

      {rolledBackBanner !== null && (
        <section
          data-testid="rolled-back-banner"
          className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]"
        >
          <p className="font-medium">{rolledBackBanner}</p>
          <p className="mt-1 text-xs">{t('rolledBackHint')}</p>
        </section>
      )}

      {executorReady && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/5 p-4">
          <h2 className="mb-3 text-[10px] font-semibold tracking-wider text-[color:var(--danger)] uppercase">
            {t('applyTitle')}
          </h2>

          <label
            htmlFor="update-target-version"
            className="mb-1 block text-xs text-[color:var(--fg-muted)]"
          >
            {t('targetLabel')}
          </label>
          <select
            id="update-target-version"
            value={target}
            onChange={(e) => { setSelected(e.target.value); }}
            disabled={triggering || updating || awaitingRestart}
            className="w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-2 font-mono text-sm"
          >
            {versionOptions.map((option) => (
              <option key={option.tag} value={option.tag}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('targetHint')}</p>
          {releasesFailed && (
            <p className="mt-1 text-xs text-[color:var(--danger)]">
              {t('releasesUnavailable')}
            </p>
          )}

          {/* The registry verdict, before anything is touched. `checking` and
              `unsupported` are shown as themselves — an operator who cannot
              tell "missing" from "could not look" will read every ambiguity
              as a broken release. */}
          <div className="mt-4 rounded border border-[color:var(--border)] bg-[color:var(--bg)]/60 p-3">
            <h3 className="mb-2 text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
              {t('imageCheckTitle')}
            </h3>
            <p
              data-testid="image-check-summary"
              className={`text-sm ${
                checkState === 'failed'
                  ? 'text-[color:var(--danger)]'
                  : 'text-[color:var(--fg-muted)]'
              }`}
            >
              {checkState === 'checking' && t('imageCheckChecking', { version: target })}
              {checkState === 'ok' && t('imageCheckOk', { version: target })}
              {checkState === 'failed' && t('imageCheckFailed', { version: target })}
              {checkState === 'unsupported' && t('imageCheckUnsupported')}
              {checkState === 'error' &&
                t('imageCheckError', { message: checkError ?? '' })}
            </p>
            {preflight !== null && preflight.images.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {preflight.images.map((image) => (
                  <li key={image.service} className="flex flex-wrap items-baseline gap-x-2">
                    <span aria-hidden="true">{image.available ? '✓' : '✗'}</span>
                    <span className="font-mono break-all">
                      {image.image.length > 0 ? image.image : image.service}
                    </span>
                    <span
                      className={
                        image.available
                          ? 'text-[color:var(--fg-muted)]'
                          : 'text-[color:var(--danger)]'
                      }
                    >
                      {image.available
                        ? t('imageAvailable')
                        : t('imageMissing', { reason: image.reason ?? '' })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="mt-3 mb-2 text-xs text-[color:var(--fg-muted)]">
            {t('confirmWarning')}
          </p>
          {/* #696 — on Fly the updater moves the machines but cannot write the
              pin, because `fly deploy` reads the operator's local fly.toml.
              Saying so here is the difference between an informed click and a
              surprise revert on the next routine deploy. */}
          {status?.executor.pinPersisted === false && (
            <p className="mb-2 text-xs text-[color:var(--danger)]">
              {t('pinNotPersisted')}
            </p>
          )}
          <div className="mt-4 flex items-center justify-end">
            <Button
              variant="danger"
              onClick={() => void onTrigger()}
              disabled={!canTrigger}
            >
              {triggering ? t('triggering') : t('triggerButton', { version: target })}
            </Button>
          </div>
        </section>
      )}

      {triggerError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {triggerError}
        </section>
      )}

      {status?.auditAvailable === true && history.length > 0 && (
        <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
          <h2 className="mb-3 text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('historyTitle')}
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline gap-x-3 border-b border-[color:var(--border)]/50 pb-2 last:border-0"
              >
                <span className="font-mono">
                  {entry.fromVersion} → {entry.toVersion}
                </span>
                <span className="text-xs text-[color:var(--fg-muted)]">
                  {t(`outcomes.${entry.outcome}`)}
                </span>
                <span className="text-xs text-[color:var(--fg-muted)]">
                  {entry.actor}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
