import Link from 'next/link';
import { ArrowRight, UserX } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PrivacyPosture } from '../_lib/api';
import { PRIVACY_GUARD_STORE_HREF } from '../_lib/privacyGuard';

/**
 * #1562 — the Privacy Shield runs, but its C1 name detector does not: either
 * no sidecar URL is configured, or the sidecar does not answer. C0 still masks
 * fixed formats (e-mail, IBAN, phone…), so this is a calm notice next to
 * `PrivacyShieldBanner`, not an alarm — but names in free text reach the LLM
 * provider unmasked, and before this the boot log was the only place that
 * said so.
 *
 * Renders nothing when the posture is unknown, the shield is off (the shield
 * banner covers that), the backend predates the field, or C1 is active. An
 * unconfigured C1 shows only while `mask_user_prompt` is on: on a default
 * install (prompt masking off) the operator never asked for names in prompts
 * to be masked, and a permanent banner there would be noise; the guard's
 * store page still shows the state.
 */
export function NameDetectorBanner({
  posture,
}: {
  posture: PrivacyPosture | null;
}): React.ReactElement | null {
  const detector = posture?.shield_active ? posture.name_detector : undefined;
  const state = detector?.state;
  if (state === 'unconfigured' && detector?.prompt_masking !== true) return null;
  if (state !== 'unconfigured' && state !== 'unreachable') return null;
  return <NameDetectorNotice state={state} />;
}

function NameDetectorNotice({
  state,
}: {
  state: 'unconfigured' | 'unreachable';
}): React.ReactElement {
  const t = useTranslations('privacyNameDetector');
  return (
    <div
      role="status"
      data-testid="name-detector-banner"
      className="mb-8 flex flex-col gap-3 rounded-lg border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-4 sm:flex-row sm:items-start"
    >
      <UserX className="mt-0.5 size-5 shrink-0 text-[color:var(--warning)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {state === 'unconfigured' ? t('bannerTitleOff') : t('bannerTitleUnreachable')}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
          {state === 'unconfigured' ? t('bannerBodyOff') : t('bannerBodyUnreachable')}
        </p>
      </div>
      <Link
        href={PRIVACY_GUARD_STORE_HREF}
        className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] hover:underline"
      >
        {t('cta')}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}
