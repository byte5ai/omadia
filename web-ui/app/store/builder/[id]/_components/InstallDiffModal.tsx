'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { AlertTriangle, CheckCircle2, ShieldCheck, X } from 'lucide-react';

import { getBuilderInstallManifest, installBuilderDraft, patchBuilderSpec } from '../../../../_lib/api';
import { ActivationFailureNotice } from '../../../../_components/store/ActivationFailureNotice';
import { cn } from '../../../../_lib/cn';
import { storeErrorText } from '../../../../_lib/packageErrorText';
import type {
  BuilderInstallManifest,
  BuilderInstallOptions,
  Draft,
  InstallFailureReason,
  InstallResponse,
} from '../../../../_lib/builderTypes';

/**
 * Frontend mirror of middleware's `bumpPatchVersion` (Theme C). Strips
 * any prerelease tag and increments the patch segment. Returns input
 * unchanged for non-semver garbage so the operator's typo stays
 * surfaced rather than silently rewritten.
 *
 * Examples: 0.1.0 → 0.1.1, 1.2.3-alpha.4 → 1.2.4, 'whatever' → 'whatever'.
 */
function bumpPatchVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$/.exec(version);
  if (!m) return version;
  const [, major, minor, patch] = m;
  return `${major}.${minor}.${String(Number(patch) + 1)}`;
}

type InstallT = ReturnType<typeof useTranslations<'builder.install'>>;

export interface InstallDiffModalProps {
  draft: Draft;
  open: boolean;
  onClose: () => void;
  /** Optional override for tests — defaults to the real installBuilderDraft. */
  install?: (draftId: string, options?: BuilderInstallOptions) => Promise<InstallResponse>;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'failed'; failure: InstallFailureBody }
  | { kind: 'succeeded'; publishedAgentId: string; version: string; activated: boolean };

interface InstallFailureBody {
  reason: InstallFailureReason;
  code: string;
  message: string;
  params?: Record<string, string>;
  details?: unknown;
}

export function InstallDiffModal({
  draft,
  open,
  onClose,
  install,
}: InstallDiffModalProps): React.ReactElement | null {
  const t = useTranslations('builder.install');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [review, setReview] = useState<{ key: string; manifest: BuilderInstallManifest | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reviewKey = `${draft.id}:${String(draft.updatedAt)}:${String(attempt)}`;
  const manifest = review?.key === reviewKey ? review.manifest : null;
  const manifestFailed = review?.key === reviewKey && review.manifest === null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getBuilderInstallManifest(draft.id).then(
      (data) => { if (!cancelled) setReview({ key: reviewKey, manifest: data }); },
      () => { if (!cancelled) setReview({ key: reviewKey, manifest: null }); },
    );
    return () => { cancelled = true; };
  }, [open, draft.id, reviewKey]);

  if (!open) return null;

  const busy = phase.kind === 'installing';

  const handleInstall = async (confirmation?: BuilderInstallOptions['downgradeConfirmation']): Promise<void> => {
    if (!manifest) return;
    setPhase({ kind: 'installing' });
    try {
      const fn = install ?? installBuilderDraft;
      const result = await fn(draft.id, {
        review: {
          fingerprint: manifest.fingerprint,
          installed: {
            version: manifest.installedVersion,
            manifestFingerprint: manifest.installedManifestFingerprint,
          },
        },
        ...(confirmation ? { allowDowngrade: true, downgradeConfirmation: confirmation } : {}),
      });
      if (result.ok) {
        setPhase({
          kind: 'succeeded',
          publishedAgentId: result.publishedAgentId,
          version: result.version,
          activated: result.activated === true,
        });
        return;
      }
      setPhase({
        kind: 'failed',
        failure: {
          reason: result.reason,
          code: result.code,
          message: result.message,
          ...(result.params !== undefined ? { params: result.params } : {}),
          ...(result.details !== undefined ? { details: result.details } : {}),
        },
      });
    } catch (err) {
      setPhase({
        kind: 'failed',
        failure: {
          reason: 'ingest_failed',
          code: 'builder.transport_error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  const handleClose = (): void => {
    if (busy) return;
    setPhase({ kind: 'idle' });
    setReview(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('publishTitle')}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- full-screen modal overlay/backdrop dismiss button, no text */}
      <button
        type="button"
        onClick={handleClose}
        aria-label={t('closeModalAria')}
        disabled={busy}
        className="absolute inset-0 bg-[color:var(--ink)]/40 backdrop-blur-sm transition disabled:cursor-wait"
      />

      <div
        className={cn(
          'relative z-10 flex w-full max-w-4xl flex-col',
          'border border-[color:var(--rule-strong)] bg-[color:var(--paper)]',
          'shadow-[0_30px_80px_-20px_rgba(0,0,0,0.4)]',
          'max-h-[90vh] overflow-hidden',
        )}
      >
        <header className="flex items-start justify-between gap-6 border-b border-[color:var(--rule)] px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
              <ShieldCheck className="size-3.5" aria-hidden />
              {t(manifest?.installedManifest ? 'manifestComparison' : 'manifestReview')}
            </div>
            <h2 className="font-display mt-1 text-2xl font-medium leading-tight text-[color:var(--ink)]">
              {t('publishTitle')}
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
              {t('publishLeadPrefix')}{' '}
              <span className="font-mono-num">{manifest?.pluginId ?? draft.spec.id}</span> v
              {manifest?.version ?? draft.spec.version} {t('publishLeadSuffix')}
            </p>
          </div>
          {/* eslint-disable-next-line no-restricted-syntax -- icon-only header close button (X), no text */}
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className="text-[color:var(--muted-ink)] transition hover:text-[color:var(--ink)] disabled:opacity-40"
            aria-label={t('closeAria')}
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          {phase.kind === 'failed' ? (
            <FailureBanner
              t={t}
              failure={phase.failure}
              onRetry={() => {
                setPhase({ kind: 'idle' });
                setAttempt((count) => count + 1);
              }}
              onDowngrade={
                manifest ? (confirmation) => handleInstall(confirmation) : undefined
              }
              currentVersion={manifest?.version ?? draft.spec.version}
              onBumpAndRetry={async () => {
                // Review the new manifest before publishing the bumped version.
                const currentVersion = manifest?.version ?? draft.spec.version;
                const next = bumpPatchVersion(currentVersion);
                if (next === currentVersion) {
                  setPhase({
                    kind: 'failed',
                    failure: {
                      reason: 'conflict',
                      code: 'builder.bump_invalid_semver',
                      message: t('bumpInvalidSemver', {
                        version: currentVersion,
                      }),
                    },
                  });
                  return;
                }
                try {
                  await patchBuilderSpec(draft.id, [
                    { op: 'replace', path: '/version', value: next },
                  ]);
                } catch (err) {
                  setPhase({
                    kind: 'failed',
                    failure: {
                      reason: 'conflict',
                      code: 'builder.bump_patch_failed',
                      message:
                        err instanceof Error ? err.message : String(err),
                    },
                  });
                  return;
                }
                setPhase({ kind: 'idle' });
                setAttempt((count) => count + 1);
              }}
            />
          ) : null}
          {phase.kind === 'succeeded' ? (
            <SuccessBanner
              t={t}
              publishedAgentId={phase.publishedAgentId}
              version={phase.version}
              activated={phase.activated}
            />
          ) : null}

          {manifest ? (
            <ManifestReview data={manifest} t={t} />
          ) : manifestFailed ? (
            <div role="alert" className="space-y-3">
              <p>{t('manifestUnavailable')}</p>
              <Button variant="secondary" onClick={() => {
                setAttempt((count) => count + 1);
              }}>{t('retry')}</Button>
            </div>
          ) : (
            <p role="status">{t('loadingManifest')}</p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-[color:var(--rule)] px-6 py-4">
          <Button
            variant="ghost"
            onClick={handleClose}
            disabled={busy}
            className="text-[12px] font-semibold uppercase tracking-[0.18em]"
          >
            {t('back')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleInstall()}
            disabled={
              busy || !manifest || phase.kind === 'succeeded' ||
              (phase.kind === 'failed' && (
                phase.failure.code === 'package.downgrade_blocked' || phase.failure.reason === 'activation_failed'
              ))
            }
            className="text-[12px] uppercase tracking-[0.18em]"
          >
            {busy ? (
              <>
                <span className="lume-busy-dots" aria-hidden />
                {t('publishing')}
              </>
            ) : phase.kind === 'succeeded' ? (
              <>
                <CheckCircle2 className="size-3.5" aria-hidden />
                {t('succeeded')}
              </>
            ) : (
              t('publish')
            )}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

function flattenManifest(manifest: Record<string, unknown>): Map<string, string> {
  const values = new Map<string, string>();
  function add(path: string, value: unknown) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value) && value.some((item) => item && typeof item === 'object')) {
        value.forEach((item, index) => add(`${path}[${String(index)}]`, item));
        return;
      }
      if (!Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.length > 0) {
          entries.forEach(([key, child]) => add(path ? `${path}.${key}` : key, child));
          return;
        }
      }
    }
    values.set(path, typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)));
  }
  Object.entries(manifest).forEach(([key, value]) => add(key, value));
  return values;
}

function ManifestReview({
  data,
  t,
}: {
  data: BuilderInstallManifest;
  t: InstallT;
}): React.ReactElement {
  const after = flattenManifest(data.manifest);
  const before = data.installedManifest ? flattenManifest(data.installedManifest) : null;
  const paths = [...new Set([...after.keys(), ...(before?.keys() ?? [])])].sort();
  const generatedFeatures = data.generatedFeatures;

  return (
    <div className="space-y-4">
      {data.installedVersion && (
        <p role="status" className="text-sm">
          {t(before ? 'compareVersion' : 'baselineUnavailable', { version: data.installedVersion })}
        </p>
      )}
      <dl className="divide-y divide-[color:var(--divider)]">
        {paths.map((path) => {
          const previous = before?.get(path);
          const next = after.get(path);
          const changed = before && previous !== next;
          return (
            <div key={path} className="grid gap-2 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <dt className="break-all font-mono text-xs">{path}</dt>
              <dd className="min-w-0 text-xs">
                {changed && (
                  <div className="mb-1 font-semibold">
                    {t(previous === undefined ? 'added' : next === undefined ? 'removed' : 'changed')}
                  </div>
                )}
                {changed && previous !== undefined && (
                  <del className="block whitespace-pre-wrap break-words text-[color:var(--danger)]">{previous}</del>
                )}
                {next !== undefined && <div className="whitespace-pre-wrap break-words">{next}</div>}
              </dd>
            </div>
          );
        })}
      </dl>
      {(generatedFeatures.external_reads.length || generatedFeatures.ui_routes.length) ? (
        <details>
          <summary>{t('generatedFeatures')}</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{JSON.stringify(generatedFeatures, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function FailureBanner({
  t,
  failure,
  onRetry,
  onDowngrade,
  currentVersion,
  onBumpAndRetry,
}: {
  t: InstallT;
  failure: InstallFailureBody;
  onRetry: () => void;
  onDowngrade?: (confirmation: NonNullable<BuilderInstallOptions['downgradeConfirmation']>) => Promise<void>;
  currentVersion: string;
  onBumpAndRetry: () => void | Promise<void>;
}): React.ReactElement {
  const tUpload = useTranslations('store.upload.errors');
  const tRoot = useTranslations();
  // #1477 — `package.incompatible_core` shares the 409 `conflict` reason with
  // the id/version collisions, but "change the id" is the wrong advice for
  // it: the error-help copy in `message` below says what to do instead.
  if (failure.reason === 'activation_failed') {
    const details = failure.details as { errorCode?: string; pluginId?: string } | undefined;
    return (
      <div className="mb-6 space-y-2">
        <ActivationFailureNotice code={details?.errorCode} detail={failure.message} lead={t('activationFailed')} />
        {details?.pluginId && (
          <Link className="text-sm text-[color:var(--accent)] underline" href={`/store/${encodeURIComponent(details.pluginId)}#install`}>
            {t('openStore')}
          </Link>
        )}
      </div>
    );
  }
  const isDowngrade = failure.code === 'package.downgrade_blocked';
  const stale = failure.code === 'builder.install_review_stale' || failure.code === 'package.install_review_stale';
  const showConflictHint = !isDowngrade && !stale && failure.code !== 'package.incompatible_core';
  const headingKey = isDowngrade ? 'downgradeHeading' : showConflictHint ? HEADING_KEYS[failure.reason] : undefined;
  const heading = headingKey ? t(headingKey) : t('failureGenericHeading');
  const hintKey = showConflictHint ? HINT_KEYS[failure.reason] : undefined;
  const hint = hintKey ? t(hintKey) : undefined;
  // The ingest pipeline writes its messages in German; render known codes
  // from the catalog with their params, the server text only as fallback.
  const message = stale ? t('reviewStale') : storeErrorText(
    { code: failure.code, message: failure.message, ...(failure.params ? { params: failure.params } : {}) },
    failure.message,
    tUpload,
    tRoot,
  );
  // Theme C: only the duplicate_version sub-case of `conflict` is fixable
  // by bumping. We can't reliably distinguish from `id` collisions on
  // reason alone, so we ALSO check the code prefix. `package.duplicate_version`
  // is the canonical code emitted by packageUploadService.
  const isDuplicateVersion =
    failure.reason === 'conflict' &&
    failure.code.includes('duplicate_version');
  const bumped = isDuplicateVersion ? bumpPatchVersion(currentVersion) : null;
  const canBump = bumped !== null && bumped !== currentVersion;
  const { pluginId, fromVersion, toVersion } = failure.params ?? {};
  const confirmation = pluginId && fromVersion && toVersion && toVersion === currentVersion
    ? { pluginId, fromVersion, toVersion }
    : undefined;

  return (
    <div className="mb-6 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 px-4 py-3">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-[color:var(--danger)]"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-display text-[13px] font-semibold text-[color:var(--danger)]">
              {heading}
            </p>
            <span className="font-mono-num text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
              {failure.code}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-[color:var(--fg-strong)]">
            {message}
          </p>
          {hint ? (
            <p className="mt-2 text-[11px] italic text-[color:var(--fg-muted)]">
              {hint}
            </p>
          ) : null}
          <FailureDetails failure={failure} t={t} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canBump ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onBumpAndRetry()}
                className="text-[11px] uppercase tracking-[0.16em]"
              >
                {t('bumpAndPublish', { current: currentVersion, next: bumped ?? '' })}
              </Button>
            ) : null}
            {isDowngrade && confirmation && onDowngrade ? (
              <Button variant="primary" size="sm" onClick={() => { void onDowngrade(confirmation); }}>
                {t('confirmDowngrade', { version: confirmation.toVersion })}
              </Button>
            ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              className="text-[11px] uppercase tracking-[0.16em]"
            >
              {t('retry')}
            </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FailureDetails({
  failure,
  t,
}: {
  failure: InstallFailureBody;
  t: InstallT;
}): React.ReactElement | null {
  const details = failure.details;
  if (!details || typeof details !== 'object') return null;

  // build_failed → { errors: BuildError[], stderrTail, ... }
  if (failure.reason === 'build_failed') {
    const errors = (details as { errors?: unknown[] }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
            {t('typescriptErrors', { count: errors.length })}
          </summary>
          <ul className="mt-2 space-y-1">
            {errors.slice(0, 10).map((e, i) => {
              const row = e as {
                path?: string;
                line?: number;
                col?: number;
                code?: string;
                message?: string;
              };
              return (
                <li
                  key={i}
                  className="rounded border border-[color:var(--divider)] bg-[color:var(--paper)] px-2 py-2 text-[10px] font-mono leading-relaxed"
                >
                  <span className="text-[color:var(--fg-subtle)]">
                    {row.path ?? '?'}:{row.line ?? '?'}:{row.col ?? '?'}
                  </span>
                  <span className="ml-2 text-[color:var(--danger)]">
                    {row.code ?? ''}
                  </span>
                  <div className="mt-0.5 text-[color:var(--fg-strong)]">
                    {row.message ?? ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      );
    }
  }

  // codegen_failed → { issues: CodegenIssue[] }
  if (failure.reason === 'codegen_failed') {
    const issues = (details as { issues?: unknown[] }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
            {t('codegenIssues', { count: issues.length })}
          </summary>
          <ul className="mt-2 space-y-1">
            {issues.map((i, idx) => {
              const row = i as { code?: string; detail?: string };
              return (
                <li
                  key={idx}
                  className="rounded border border-[color:var(--divider)] bg-[color:var(--paper)] px-2 py-2 text-[11px]"
                >
                  <span className="font-mono-num text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-subtle)]">
                    {row.code ?? '?'}
                  </span>
                  <div className="mt-0.5 text-[color:var(--fg-strong)]">
                    {row.detail ?? ''}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      );
    }
  }

  return null;
}

function SuccessBanner({
  t,
  publishedAgentId,
  version,
  activated,
}: {
  t: InstallT;
  publishedAgentId: string;
  version: string;
  activated: boolean;
}): React.ReactElement {
  return (
    <div className="mb-6 rounded-md border border-[color:var(--success)]/40 bg-[color:var(--success)]/6 px-4 py-3">
      <div className="flex items-start gap-3">
        <CheckCircle2
          className="mt-0.5 size-4 shrink-0 text-[color:var(--success)]"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-display text-[13px] font-semibold text-[color:var(--success)]">
            {t('successHeading')}
          </p>
          <p className="mt-1 text-[12px] text-[color:var(--fg-strong)]">
            <span className="font-mono-num">{publishedAgentId}</span> v{version}{' '}
            {t(activated ? 'successActivated' : 'successNeedsInstall')}
          </p>
          <Link
            className="mt-2 inline-block text-sm text-[color:var(--accent)] underline"
            href={`/store/${encodeURIComponent(publishedAgentId)}#install`}
          >
            {t('openStore')}
          </Link>
        </div>
      </div>
    </div>
  );
}

const HEADING_KEYS: Partial<Record<InstallFailureReason, string>> = {
  conflict: 'headingConflict',
  build_failed: 'headingBuildFailed',
  codegen_failed: 'headingCodegenFailed',
  spec_invalid: 'headingSpecInvalid',
  manifest_invalid: 'headingManifestInvalid',
  too_large: 'headingTooLarge',
  pipeline_failed: 'headingPipelineFailed',
  ingest_failed: 'headingIngestFailed',
  draft_not_found: 'headingDraftNotFound',
};

const HINT_KEYS: Partial<Record<InstallFailureReason, string>> = {
  conflict: 'hintConflict',
  build_failed: 'hintBuildFailed',
  codegen_failed: 'hintCodegenFailed',
  spec_invalid: 'hintSpecInvalid',
  too_large: 'hintTooLarge',
};
