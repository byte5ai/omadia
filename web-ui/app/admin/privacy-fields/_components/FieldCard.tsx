'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  type FieldClassificationAction,
  type FieldClassificationItem,
  type FieldClassificationPreview,
  type FieldClassificationStatus,
  previewFieldClassification,
} from '../../../_lib/api';
import { serverErrorMessage } from '../../../_lib/apiErrorMessage';
import { formatWhen, modelList, reasonText, scopeText } from './fieldText';

/** The legacy-entries view of the page (`?view=legacy`). */
export const LEGACY_VIEW_HREF = '/admin/privacy-fields?view=legacy';

/**
 * Which decisions the kernel accepts per status (see the field-classification
 * contract). `rejected` / `kept_masked` stay until the candidate changes, then
 * come back as `needs_clarification`; `revert` undoes them (and a
 * confirmation) by hand. On `confirmed_conflict` (a listed field that now
 * points to a person model or changed since) `confirm` acknowledges it —
 * the setting stays as it is — and `revert` removes the entry.
 */
const ACTIONS_BY_STATUS: Record<FieldClassificationStatus, readonly FieldClassificationAction[]> = {
  suggested: ['confirm', 'reject', 'keep_masked'],
  needs_clarification: ['confirm', 'reject', 'keep_masked'],
  personal: ['keep_masked'],
  confirmed: ['revert'],
  confirmed_conflict: ['confirm', 'revert'],
  rejected: ['revert'],
  kept_masked: ['revert'],
};

export function actionsFor(status: FieldClassificationStatus): readonly FieldClassificationAction[] {
  return ACTIONS_BY_STATUS[status] ?? [];
}

/** The catalog key of an action's button label in a status. */
export function actionLabelKey(
  status: FieldClassificationStatus,
  action: FieldClassificationAction,
): string {
  return status === 'confirmed_conflict' && action === 'confirm'
    ? 'actions.acknowledge'
    : `actions.${action}`;
}

/** A message shown on one card after a decision attempt. */
export type CardNotice =
  | { kind: 'saved'; entry: string }
  | { kind: 'stale' }
  | { kind: 'gone' }
  | { kind: 'legacy'; entry: string }
  | { kind: 'invalid' }
  | { kind: 'error'; detail: string | null };

type PreviewState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | ({ kind: 'shown' } & FieldClassificationPreview)
  | { kind: 'error'; detail: string | null };

export function FieldCard({
  item,
  busyAction,
  notice,
  onDecide,
}: {
  item: FieldClassificationItem;
  /** The action in flight for this item, if any. */
  busyAction: FieldClassificationAction | null;
  notice: CardNotice | null;
  onDecide: (item: FieldClassificationItem, action: FieldClassificationAction) => void;
}): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const format = useFormatter();
  const [preview, setPreview] = useState<PreviewState>({ kind: 'hidden' });

  const togglePreview = async (): Promise<void> => {
    if (preview.kind === 'shown') {
      setPreview({ kind: 'hidden' });
      return;
    }
    setPreview({ kind: 'loading' });
    try {
      const sample = await previewFieldClassification(item.id);
      setPreview({ kind: 'shown', ...sample });
    } catch (err) {
      setPreview({ kind: 'error', detail: serverErrorMessage(err) });
    }
  };

  const decidedAt = formatWhen(item.decision?.at, format);
  const lastSeen = formatWhen(item.lastSeenAt, format);
  const actions = actionsFor(item.status);
  const legacyEntry = item.reasons.find((r) => r.code === 'legacy_entry')?.entry;

  return (
    <li
      data-testid={`field-${item.id}`}
      className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="font-mono text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {item.fieldPath}
        </code>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {t(`status.${item.status}`)}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-[color:var(--fg-muted)]">{t('valueShape')}</dt>
        <dd>{t(`shape.${item.valueShape}`)}</dd>
        <dt className="text-[color:var(--fg-muted)]">{t('source')}</dt>
        <dd className="font-mono" data-testid="field-source">
          {item.toolName} · {scopeText(item, t)}
        </dd>
        {item.label !== null && item.label !== item.fieldPath ? (
          <>
            <dt className="text-[color:var(--fg-muted)]">{t('label')}</dt>
            <dd>{item.label}</dd>
          </>
        ) : null}
        <dt className="text-[color:var(--fg-muted)]">{t('relationModels')}</dt>
        <dd className="font-mono">{modelList(item.relationModels, t, format)}</dd>
        <dt className="text-[color:var(--fg-muted)]">{t('configEntry')}</dt>
        <dd className="font-mono">{item.configEntry}</dd>
      </dl>

      {legacyEntry !== undefined ? (
        <p className="mt-2 text-[13px] text-[color:var(--fg-muted)]" data-testid="field-legacy">
          {t('legacyNote', { entry: legacyEntry })}{' '}
          <Link href={LEGACY_VIEW_HREF} className="text-[color:var(--accent)] hover:underline">
            {t('legacy.open')}
          </Link>
        </p>
      ) : null}


      {item.reasons.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('reasonsHeading')}
          </div>
          <ul className="mt-1 list-disc pl-5 text-[13px]">
            {item.reasons.map((reason, i) => (
              <li key={`${reason.code}-${String(i)}`}>{reasonText(reason, t, format)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {lastSeen !== null ? (
        <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
          {t('seen', { count: item.seenCount, when: lastSeen })}
        </p>
      ) : null}

      {item.decision !== null && decidedAt !== null ? (
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]" data-testid="field-decision">
          {t(`decision.${item.decision.action}`, {
            by: item.decision.by ?? t('decision.unknownActor'),
            when: decidedAt,
          })}
        </p>
      ) : null}

      {notice !== null ? <NoticeLine notice={notice} /> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={action === 'confirm' ? 'primary' : 'secondary'}
            disabled={busyAction !== null}
            busy={busyAction === action}
            busyLabel={t('actions.working')}
            onClick={() => onDecide(item, action)}
          >
            {t(actionLabelKey(item.status, action))}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          busy={preview.kind === 'loading'}
          busyLabel={t('actions.loadingSample')}
          aria-expanded={preview.kind === 'shown'}
          onClick={() => void togglePreview()}
        >
          {preview.kind === 'shown' ? t('actions.hideSample') : t('actions.showSample')}
        </Button>
      </div>

      {preview.kind === 'shown' ? (
        <SamplePanel
          samples={preview.samples}
          maskedSamples={preview.maskedSamples}
          samplesWithheld={preview.samplesWithheld}
        />
      ) : preview.kind === 'error' ? (
        <ErrorLine message={t('errors.preview')} detail={preview.detail} />
      ) : null}
    </li>
  );
}

function NoticeLine({ notice }: { notice: CardNotice }): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  switch (notice.kind) {
    case 'saved':
      return (
        <p role="status" className="mt-3 text-[13px] text-[color:var(--accent)]">
          {t('saved', { entry: notice.entry })}
        </p>
      );
    case 'stale':
      return <ErrorLine message={t('errors.stale')} detail={null} />;
    case 'gone':
      return <ErrorLine message={t('errors.notFound')} detail={null} />;
    case 'legacy':
      return <ErrorLine message={t('errors.coveredByLegacy', { entry: notice.entry })} detail={null} />;
    case 'invalid':
      return <ErrorLine message={t('errors.invalidField')} detail={null} />;
    case 'error':
      return <ErrorLine message={t('errors.decision')} detail={notice.detail} />;
  }
}

export function ErrorLine({
  message,
  detail,
}: {
  message: string;
  detail: string | null;
}): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/5 px-3 py-2 text-[13px] text-[color:var(--danger)]"
    >
      <p>{message}</p>
      {detail !== null ? (
        <p className="mt-1 text-xs opacity-80">{t('errors.detail', { message: detail })}</p>
      ) : null}
    </div>
  );
}

/** Real values (admins only, the view is audited) with the masked fallback;
 *  masked only for an uploaded dataset (its rows belong to the uploader). */
function SamplePanel({
  samples,
  maskedSamples,
  samplesWithheld,
}: FieldClassificationPreview): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  return (
    <div className="mt-3" data-testid="field-sample">
      <p className="text-xs font-semibold text-[color:var(--fg-muted)]" data-testid="field-sample-note">
        {samplesWithheld === 'owner_scoped_dataset' ? t('sampleDatasetNote') : t('sampleAdminNote')}
      </p>
      {samples.length > 0 ? (
        <>
          <div className="mt-2 text-xs text-[color:var(--fg-muted)]">{t('sampleHeading')}</div>
          <ul className="mt-1 flex flex-col gap-1 font-mono text-[13px]" data-testid="field-sample-real">
            {samples.map((sample, i) => (
              <li key={`${String(i)}-${sample}`}>{sample}</li>
            ))}
          </ul>
        </>
      ) : maskedSamples.length > 0 ? (
        <>
          <div className="mt-2 text-xs text-[color:var(--fg-muted)]">{t('sampleMaskedHeading')}</div>
          <ul className="mt-1 flex flex-col gap-1 font-mono text-[13px]" data-testid="field-sample-masked">
            {maskedSamples.map((sample, i) => (
              <li key={`${String(i)}-${sample}`}>{sample}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-1 text-[13px]">{t('sampleEmpty')}</p>
      )}
    </div>
  );
}
