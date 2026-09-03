'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { ProviderCredentialStatus } from '../../_lib/api';

/**
 * Body of onboarding step 1 ("LLM verbinden"). The step frame (number,
 * checkmark, title) stays in `DashboardOnboarding`'s `StepShell`; this file
 * owns only what the operator reads INSIDE the step, in its three states:
 *
 *   1. runtime up          → a sentence that names what the orchestrator
 *                            actually runs on (OM-74, #999)
 *   2. access, no runtime  → the assignment is missing (OM-78 / #1001, the
 *                            handoff gap of #994)
 *   3. nothing yet         → the two connect CTAs
 *
 * Extracted so `DashboardOnboarding.tsx` stays under the file-size limit.
 */

/** What KIND of provider the orchestrator is assigned to. `null` = unknown
 *  (the providers call failed or no assignment matched a provider row). */
export type AssignedProviderKind = 'cli' | 'oauth' | 'api' | null;

export interface LlmStepBodyProps {
  /** Step 1 is done: `/operator/agents` answers (see `DashboardOnboarding`). */
  readonly done: boolean;
  /** A stored access exists (verified key or CLI login) but `done` is false. */
  readonly accessWithoutRuntime: boolean;
  readonly assignedProviderKind: AssignedProviderKind;
  /** The assigned provider's credential verdict; `null` when unknown. */
  readonly assignedProviderStatus: ProviderCredentialStatus | null;
  /** The assigned provider's display label; `null` when unknown. */
  readonly assignedProviderLabel: string | null;
}

const PRIMARY_CTA =
  'inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-cta)] transition-colors hover:bg-[color:var(--accent-hover)]';
const SECONDARY_CTA =
  'inline-flex items-center gap-2 rounded-full border border-[color:var(--accent)] px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-[color:var(--accent)] transition-colors hover:bg-[color:var(--accent-subtle)]';
const BODY = 'mt-2 max-w-2xl text-[13px] leading-relaxed text-[color:var(--fg-muted)]';

/**
 * OM-74 (#999) — the done-copy follows the orchestrator's ASSIGNMENT and the
 * verdict on that assignment's credential. "Its key was verified" was shown to
 * a subscription user who never stored a key; it must also not be shown for
 * an unverified or rejected key that the runtime happens to run on, nor when
 * the provider list is unavailable (kind `null`).
 */
function doneCopy(
  t: ReturnType<typeof useTranslations<'dashboard.onboarding.llmStep'>>,
  kind: AssignedProviderKind,
  status: ProviderCredentialStatus | null,
  label: string | null,
): string {
  if (kind === 'cli') return t('doneViaCli');
  if (kind === 'oauth') return t('doneViaOauth');
  if (kind === 'api' && status === 'verified') return t('doneViaProvider');
  return label === null
    ? t('doneViaRuntimeNoLabel')
    : t('doneViaRuntime', { label });
}

export function LlmStepBody({
  done,
  accessWithoutRuntime,
  assignedProviderKind,
  assignedProviderStatus,
  assignedProviderLabel,
}: LlmStepBodyProps): React.ReactElement {
  const t = useTranslations('dashboard.onboarding.llmStep');

  if (done) {
    return (
      <p data-testid="onboarding-step-1-done-copy" className={BODY}>
        {doneCopy(t, assignedProviderKind, assignedProviderStatus, assignedProviderLabel)}
      </p>
    );
  }

  if (accessWithoutRuntime) {
    // An access exists but the runtime is down: the missing piece is almost
    // always the orchestrator's provider assignment (#994), so the step says
    // that instead of offering to connect an access the operator already has.
    return (
      <>
        <p data-testid="onboarding-step-1-assign-hint" className={BODY}>
          {t('accessWithoutRuntime')}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link href="/admin/providers" className={PRIMARY_CTA}>
            {t('assignOrchestrator')}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <p className={BODY}>{t('description')}</p>
      {/* Step 1 offers both supported LLM access paths directly so the CTA
          matches the promise in the copy above. */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link href="/admin/providers" className={PRIMARY_CTA}>
          {t('connectApiKey')}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        <Link href="/admin/providers?tab=subscriptions" className={SECONDARY_CTA}>
          {t('connectSubscription')}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </>
  );
}
