import Link from 'next/link';
import { ArrowRight, ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PrivacyPosture } from '../_lib/api';
import { PRIVACY_GUARD_STORE_HREF } from '../_lib/privacyGuard';

/**
 * #1507 — the Privacy Shield is an ordinary plugin. Without a running
 * `privacy.redact@1` provider the orchestrator sends every turn to the LLM
 * unmasked and shows no receipt, and before this banner nothing in the product
 * said so. Rendered on the pages an operator opens first (dashboard, `/admin`)
 * next to `PlatformHealthBanner`.
 *
 * `posture === null` means the posture could not be read: no banner, because
 * an unknown state is not evidence that the shield is off. Not dismissible —
 * running without the shield is a state to fix or to decide on, not to hide.
 */
export function PrivacyShieldBanner({
  posture,
}: {
  posture: PrivacyPosture | null;
}): React.ReactElement | null {
  if (posture === null || posture.shield_active) return null;
  return (
    <ShieldOffNotice
      forceGuarded={posture.force_guarded}
      installed={posture.provider_ids.length > 0}
    />
  );
}

function ShieldOffNotice({
  forceGuarded,
  installed,
}: {
  forceGuarded: boolean;
  /** The guard is installed but publishes nothing — it failed to start, so
   *  the fix is on its store page, not a reinstall. */
  installed: boolean;
}): React.ReactElement {
  const t = useTranslations('privacyShieldBanner');
  return (
    <div
      role="alert"
      data-testid="privacy-shield-banner"
      className="mb-8 flex flex-col gap-3 rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-4 sm:flex-row sm:items-start"
    >
      <ShieldOff className="mt-0.5 size-5 shrink-0 text-[color:var(--danger)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {t('title')}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
          {installed
            ? t('bodyNotRunning')
            : forceGuarded
              ? t('bodyForceGuarded')
              : t('body')}
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
