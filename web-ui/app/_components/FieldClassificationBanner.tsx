import Link from 'next/link';
import { ArrowRight, ListChecks } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PrivacyPosture } from '../_lib/api';

/** Where the banner (and the nav badge) send the admin. */
export const FIELD_CLASSIFICATION_HREF = '/admin/privacy-fields';
export const FIELD_CLASSIFICATION_CLARIFY_HREF = `${FIELD_CLASSIFICATION_HREF}?status=needs_clarification`;
export const FIELD_CLASSIFICATION_SUGGESTED_HREF = `${FIELD_CLASSIFICATION_HREF}?status=suggested`;
export const FIELD_CLASSIFICATION_CONFLICT_HREF = `${FIELD_CLASSIFICATION_HREF}?status=confirmed_conflict`;
export const FIELD_CLASSIFICATION_AUTO_APPROVED_HREF = `${FIELD_CLASSIFICATION_HREF}?status=auto_approved`;
export const FIELD_CLASSIFICATION_AUTO_REVOKED_HREF = `${FIELD_CLASSIFICATION_HREF}?status=auto_revoked`;

function countOf(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Fields an admin has to look at (needs clarification — incl. revoked
 * auto-approvals and confirmed fields in conflict — and open suggestions),
 * from the privacy posture. 0 when the posture is unknown or the backend
 * predates the fields — never a guess.
 */
export function fieldsNeedingClarification(posture: PrivacyPosture | null): number {
  return (
    countOf(posture?.fields_needing_clarification) + countOf(posture?.fields_suggested_open)
  );
}

/** Auto-approvals since the admin's last visit (informational). */
export function fieldsAutoApprovedNew(posture: PrivacyPosture | null): number {
  return countOf(posture?.fields_auto_approved_new);
}

/** Open revoked auto-approvals (part of `fields_needing_clarification`). */
export function fieldsAutoRevoked(posture: PrivacyPosture | null): number {
  return countOf(posture?.fields_auto_revoked);
}

/** The nav badge: everything to review plus new auto-approvals. */
export function fieldClassificationBadgeCount(posture: PrivacyPosture | null): number {
  return fieldsNeedingClarification(posture) + fieldsAutoApprovedNew(posture);
}

/** The decision count without the revoked auto-approvals (shown on their own). */
function fieldsWaiting(posture: PrivacyPosture | null): number {
  return Math.max(0, fieldsNeedingClarification(posture) - fieldsAutoRevoked(posture));
}

/** Where the main notice leads: the open clarifications first, then
 *  confirmed fields in conflict, the open suggestions when there are only
 *  those. `fields_needing_clarification` includes the conflicts and the
 *  revoked auto-approvals (which have their own line and tab). */
export function fieldClassificationHref(posture: PrivacyPosture | null): string {
  const conflicts = countOf(posture?.fields_confirmed_conflict);
  const clarify =
    countOf(posture?.fields_needing_clarification) - conflicts - fieldsAutoRevoked(posture);
  if (clarify > 0) return FIELD_CLASSIFICATION_CLARIFY_HREF;
  if (conflicts > 0) return FIELD_CLASSIFICATION_CONFLICT_HREF;
  return FIELD_CLASSIFICATION_SUGGESTED_HREF;
}

/**
 * #1556 follow-up — new masked fields wait for an admin decision on
 * `/admin/privacy-fields`, plus what the auto-classifier did on its own
 * (approved since the last visit, approvals it revoked). Informational
 * only: an undecided field simply stays masked, so this never blocks.
 * Rendered next to `PrivacyShieldBanner` on the dashboard and `/admin`.
 */
export function FieldClassificationBanner({
  posture,
}: {
  posture: PrivacyPosture | null;
}): React.ReactElement | null {
  const waiting = fieldsWaiting(posture);
  const revoked = fieldsAutoRevoked(posture);
  const approvedNew = fieldsAutoApprovedNew(posture);
  if (waiting + revoked + approvedNew === 0) return null;
  return (
    <FieldClassificationNotice
      waiting={waiting}
      waitingHref={fieldClassificationHref(posture)}
      revoked={revoked}
      approvedNew={approvedNew}
    />
  );
}

function NoticeLink({ href, label }: { href: string; label: string }): React.ReactElement {
  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] hover:underline"
    >
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

function FieldClassificationNotice({
  waiting,
  waitingHref,
  revoked,
  approvedNew,
}: {
  waiting: number;
  waitingHref: string;
  revoked: number;
  approvedNew: number;
}): React.ReactElement {
  const t = useTranslations('privacyFieldBanner');
  return (
    <div
      role="status"
      data-testid="field-classification-banner"
      className="mb-8 flex flex-col gap-3 rounded-lg border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-4 sm:flex-row sm:items-start"
    >
      <ListChecks className="mt-0.5 size-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {waiting > 0 ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
                {t('title', { count: waiting })}
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
                {t('body')}
              </p>
            </div>
            <NoticeLink href={waitingHref} label={t('cta')} />
          </div>
        ) : null}
        {revoked > 0 ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start" data-testid="field-banner-revoked">
            <div className="min-w-0 flex-1 text-[14px] font-semibold text-[color:var(--fg-strong)]">
              {t('autoRevoked', { count: revoked })}
            </div>
            <NoticeLink href={FIELD_CLASSIFICATION_AUTO_REVOKED_HREF} label={t('ctaAutoRevoked')} />
          </div>
        ) : null}
        {approvedNew > 0 ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start" data-testid="field-banner-auto-approved">
            <div className="min-w-0 flex-1 text-[13px] text-[color:var(--fg-muted)]">
              {t('autoApprovedNew', { count: approvedNew })}
            </div>
            <NoticeLink href={FIELD_CLASSIFICATION_AUTO_APPROVED_HREF} label={t('ctaAutoApproved')} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
