'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { applyProfile, ApiError, profileExportUrl } from '../../_lib/api';
import { cn } from '../../_lib/cn';
import type {
  ProfileApplyOutcome,
  ProfileSummary,
} from '../../_lib/profileTypes';

/**
 * Onboarding-Modal (S+12-3) — surfaces on the store page when the
 * middleware looks fresh (`installedCount < 3`). Operator picks a
 * curated profile, the modal POSTs `/api/v1/profiles/:id/apply` and
 * shows the per-plugin outcome.
 *
 * Why threshold 3 and not 0: built-in `bootstrapBuiltInPackages` may
 * have seeded one or two leaf-tools (no-required-secret) on first
 * boot; that doesn't make the deployment "operator-ready" yet. 3
 * keeps the modal visible until the operator has run a profile or
 * manually installed enough to call it set up.
 *
 * Browser-side gating only — server-side route stays open for direct
 * scripted apply (CI seeding, ops scripts).
 */

export interface OnboardingModalProps {
  installedCount: number;
  profiles: ProfileSummary[];
  /** When true, the modal stays mounted after `installedCount >= 3` so
   *  developers can preview it via a toggle. Production use: false. */
  forceOpen?: boolean;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'applying'; profileId: string }
  | { kind: 'done'; outcome: ProfileApplyOutcome }
  | { kind: 'errored'; profileId: string; message: string };

const ONBOARDING_THRESHOLD = 3;

export function OnboardingModal({
  installedCount,
  profiles,
  forceOpen = false,
}: OnboardingModalProps): React.ReactElement | null {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const shouldShow =
    !dismissed &&
    profiles.length > 0 &&
    (forceOpen || installedCount < ONBOARDING_THRESHOLD);

  if (!shouldShow) return null;

  const busy = phase.kind === 'applying';

  const onApply = async (profileId: string): Promise<void> => {
    setPhase({ kind: 'applying', profileId });
    try {
      const outcome = await applyProfile(profileId);
      setPhase({ kind: 'done', outcome });
      // Refresh server data so the parent page picks up the new
      // installed plugins and the modal closes on next mount.
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${String(err.status)}: ${err.message}${err.body ? ` — ${err.body}` : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      setPhase({ kind: 'errored', profileId, message });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('ariaLabel')}
    >
      <button
        type="button"
        onClick={busy ? undefined : () => setDismissed(true)}
        aria-label={t('ariaCloseBackdrop')}
        disabled={busy}
        className="absolute inset-0 bg-[color:var(--ink)]/40 backdrop-blur-sm transition disabled:cursor-wait"
      />

      <div
        className={cn(
          'relative z-10 flex w-full max-w-3xl flex-col',
          'border border-[color:var(--rule-strong)] bg-[color:var(--paper)]',
          'shadow-[0_30px_80px_-20px_rgba(0,0,0,0.4)]',
          'max-h-[90vh] overflow-hidden',
        )}
      >
        <header className="flex items-start justify-between gap-6 border-b border-[color:var(--rule)] px-7 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-[color:var(--accent)]">
              <Sparkles className="size-3.5" aria-hidden />
              {t('kicker')}
            </div>
            <h2 className="font-display mt-1 text-2xl font-medium leading-tight text-[color:var(--ink)]">
              {t('title')}
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
              {t('intro', { count: installedCount })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={busy}
            className="text-[color:var(--muted-ink)] transition hover:text-[color:var(--ink)] disabled:opacity-40"
            aria-label={t('ariaClose')}
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          {phase.kind === 'done' ? (
            <OutcomeBody outcome={phase.outcome} />
          ) : phase.kind === 'errored' ? (
            <ErrorBody
              profileId={phase.profileId}
              message={phase.message}
              onRetry={() => setPhase({ kind: 'idle' })}
            />
          ) : (
            <ProfileGrid
              profiles={profiles}
              busy={busy}
              activeProfileId={
                phase.kind === 'applying' ? phase.profileId : null
              }
              onApply={onApply}
            />
          )}
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-[color:var(--rule)] px-7 py-4 text-[11px] text-[color:var(--muted-ink)]">
          <div>
            {t('exportPrefix')}{' '}
            <a
              href={profileExportUrl()}
              className="text-[color:var(--accent)] hover:underline"
            >
              {t('exportLink')}
            </a>{' '}
            {t('exportSuffix')}
          </div>
          {phase.kind === 'done' ? (
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="border border-[color:var(--rule-strong)] bg-[color:var(--paper)] px-4 py-1.5 text-[11px] uppercase tracking-[0.16em] text-[color:var(--ink)] transition hover:bg-[color:var(--ink)] hover:text-[color:var(--paper)]"
            >
              {t('done')}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

interface ProfileGridProps {
  profiles: ProfileSummary[];
  busy: boolean;
  activeProfileId: string | null;
  onApply: (profileId: string) => void;
}

function ProfileGrid({
  profiles,
  busy,
  activeProfileId,
  onApply,
}: ProfileGridProps): React.ReactElement {
  const t = useTranslations('onboarding');
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {profiles.map((profile) => {
        const isActive = activeProfileId === profile.id;
        return (
          <article
            key={profile.id}
            className={cn(
              'flex flex-col border border-[color:var(--rule)] bg-[color:var(--paper)] p-5 transition',
              !busy && 'hover:border-[color:var(--accent)]',
              isActive && 'border-[color:var(--accent)]',
            )}
          >
            <div className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--faint-ink)]">
              {profile.id}
            </div>
            <h3 className="font-display mt-1 text-lg font-medium text-[color:var(--ink)]">
              {profile.name}
            </h3>
            <p className="mt-2 flex-1 text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
              {profile.description}
            </p>
            <div className="mt-4 flex items-center gap-2 text-[11px] text-[color:var(--faint-ink)]">
              <span className="border border-[color:var(--rule)] px-2 py-0.5">
                {t('pluginCount', { count: profile.plugin_count })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onApply(profile.id)}
              disabled={busy}
              className={cn(
                'mt-4 flex items-center justify-center gap-2 border border-[color:var(--ink)] bg-[color:var(--ink)] px-4 py-2 text-[12px] uppercase tracking-[0.16em] text-[color:var(--paper)] transition',
                'hover:bg-[color:var(--accent)] hover:border-[color:var(--accent)]',
                'disabled:opacity-50 disabled:hover:bg-[color:var(--ink)] disabled:hover:border-[color:var(--ink)]',
              )}
            >
              {isActive ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t('applying')}
                </>
              ) : (
                <>{t('apply')}</>
              )}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function OutcomeBody({
  outcome,
}: {
  outcome: ProfileApplyOutcome;
}): React.ReactElement {
  const t = useTranslations('onboarding');
  const hasErrors = outcome.errored.length > 0;
  return (
    <div className="space-y-5">
      <div
        className={cn(
          'flex items-center gap-3 border px-4 py-3',
          hasErrors
            ? 'border-amber-500/50 bg-amber-50/40 text-amber-900'
            : 'border-emerald-500/50 bg-emerald-50/40 text-emerald-900',
        )}
      >
        {hasErrors ? (
          <span aria-hidden>⚠</span>
        ) : (
          <Check className="size-4" aria-hidden />
        )}
        <div className="text-[12px]">
          <div className="font-medium">
            {t.rich('outcomeAppliedTitle', {
              id: () => (
                <span className="font-mono">{outcome.profile_id}</span>
              ),
            })}
          </div>
          <div className="mt-0.5 text-[11px]">
            {t('outcomeStats', {
              installed: outcome.installed.length,
              skipped: outcome.skipped.length,
              errored: outcome.errored.length,
            })}
          </div>
        </div>
      </div>

      {outcome.installed.length > 0 ? (
        <Section title={t('sectionInstalled')}>
          <ul className="space-y-1 text-[12px] text-[color:var(--ink)]">
            {outcome.installed.map((p) => (
              <li key={p.id} className="font-mono">
                {p.id} <span className="text-[color:var(--faint-ink)]">@{p.version}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {outcome.skipped.length > 0 ? (
        <Section title={t('sectionSkipped')}>
          <ul className="space-y-1 text-[12px] text-[color:var(--muted-ink)]">
            {outcome.skipped.map((p) => (
              <li key={p.id} className="font-mono">
                {p.id}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {hasErrors ? (
        <Section title={t('sectionErrored')}>
          <ul className="space-y-2 text-[12px]">
            {outcome.errored.map((p) => (
              <li
                key={p.id}
                className="border border-amber-500/40 bg-amber-50/30 px-3 py-2 text-amber-900"
              >
                <div className="font-mono text-[11px]">{p.id}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.16em]">
                  {p.reason}
                </div>
                <div className="mt-1 text-[12px] leading-relaxed">
                  {p.message}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <p className="text-[12px] leading-relaxed text-[color:var(--muted-ink)]">
          {t.rich('secretsHint', {
            erroredTag: () => <code>errored</code>,
            reactivateTag: () => <>&quot;Reactivate&quot;</>,
          })}
        </p>
      )}
    </div>
  );
}

function ErrorBody({
  profileId,
  message,
  onRetry,
}: {
  profileId: string;
  message: string;
  onRetry: () => void;
}): React.ReactElement {
  const t = useTranslations('onboarding');
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 border border-rose-500/50 bg-rose-50/40 px-4 py-3 text-rose-900">
        <span aria-hidden>✗</span>
        <div className="text-[12px]">
          <div className="font-medium">
            {t.rich('errorTitle', {
              id: () => <span className="font-mono">{profileId}</span>,
            })}
          </div>
          <div className="mt-1 break-all text-[11px] font-mono">{message}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="border border-[color:var(--rule-strong)] bg-[color:var(--paper)] px-4 py-1.5 text-[12px] uppercase tracking-[0.16em] text-[color:var(--ink)] transition hover:bg-[color:var(--ink)] hover:text-[color:var(--paper)]"
      >
        {t('tryAnother')}
      </button>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-[0.2em] text-[color:var(--faint-ink)]">
        {title}
      </h4>
      <div className="mt-2">{children}</div>
    </div>
  );
}
