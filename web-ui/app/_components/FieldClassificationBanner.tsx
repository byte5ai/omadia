import Link from 'next/link';
import { ArrowRight, ListChecks } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PrivacyPosture } from '../_lib/api';

/** Where the banner (and the nav badge) send the admin. */
export const FIELD_CLASSIFICATION_HREF = '/admin/privacy-fields';
export const FIELD_CLASSIFICATION_CLARIFY_HREF = `${FIELD_CLASSIFICATION_HREF}?status=needs_clarification`;
export const FIELD_CLASSIFICATION_SUGGESTED_HREF = `${FIELD_CLASSIFICATION_HREF}?status=suggested`;

function countOf(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Masked fields no admin has decided yet (needs clarification + open
 * suggestions), from the privacy posture. 0 when the posture is unknown or
 * the backend predates the fields — never a guess.
 */
export function fieldsNeedingClarification(posture: PrivacyPosture | null): number {
  return (
    countOf(posture?.fields_needing_clarification) + countOf(posture?.fields_suggested_open)
  );
}

/** Where the banner and the badge lead: the open clarifications first, the
 *  open suggestions when there are only those. */
export function fieldClassificationHref(posture: PrivacyPosture | null): string {
  return countOf(posture?.fields_needing_clarification) > 0
    ? FIELD_CLASSIFICATION_CLARIFY_HREF
    : FIELD_CLASSIFICATION_SUGGESTED_HREF;
}

/**
 * #1556 follow-up — new masked fields wait for an admin decision on
 * `/admin/privacy-fields`. Informational only: until someone decides, every
 * field simply stays masked, so this never blocks or alarms. Rendered next to
 * `PrivacyShieldBanner` on the dashboard and `/admin`.
 */
export function FieldClassificationBanner({
  posture,
}: {
  posture: PrivacyPosture | null;
}): React.ReactElement | null {
  const count = fieldsNeedingClarification(posture);
  if (count === 0) return null;
  return <FieldClassificationNotice count={count} href={fieldClassificationHref(posture)} />;
}

function FieldClassificationNotice({
  count,
  href,
}: {
  count: number;
  href: string;
}): React.ReactElement {
  const t = useTranslations('privacyFieldBanner');
  return (
    <div
      role="status"
      data-testid="field-classification-banner"
      className="mb-8 flex flex-col gap-3 rounded-lg border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-4 sm:flex-row sm:items-start"
    >
      <ListChecks className="mt-0.5 size-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {t('title', { count })}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
          {t('body')}
        </p>
      </div>
      <Link
        href={href}
        className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] hover:underline"
      >
        {t('cta')}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}
