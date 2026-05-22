'use client';

import { useTranslations } from 'next-intl';

import type { PrivacyReceipt } from '../../_lib/chatSessions';

interface PrivacyReceiptCardProps {
  receipt: PrivacyReceipt;
  className?: string;
}

/**
 * Per-turn Privacy Shield v4 disclosure. Shows what the Data-Plane Boundary
 * did this turn: how many raw tool results were interned server-side, how
 * many fields were kept masked off the LLM wire, which verbs the server ran,
 * and whether the gated pseudonym projection was released.
 *
 * The receipt is PII-free by construction (counts + verb names only), so
 * this component renders it directly without any masking logic. v4 has no
 * failure surface in the receipt — a receipt existing at all means the
 * boundary did its job — so there is no severity colour-coding.
 */

// `useTranslations` is a hook so we cannot call it from the pure helper
// below. The TFn alias captures the relevant signature so `summarisePrivacyReceipt`
// stays unit-testable with a fake translator, decoupled from React.
type TFn = (key: string, values?: Record<string, string | number>) => string;

export function PrivacyReceiptCard({
  receipt,
  className,
}: PrivacyReceiptCardProps): React.ReactElement {
  const t = useTranslations('privacyReceipt');
  const verbs = receipt.verbsExecuted;

  return (
    <details
      className={[
        'mt-2 rounded text-xs ring-1',
        PALETTE.container,
        className ?? '',
      ].join(' ')}
    >
      <summary
        className={[
          'cursor-pointer select-none px-2 py-1 font-medium',
          PALETTE.summary,
        ].join(' ')}
      >
        {t('summary', { summary: summarisePrivacyReceipt(receipt, t) })}
      </summary>
      <div className={['space-y-2 px-2 pb-2 pt-1', PALETTE.body].join(' ')}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <Fact
            label={t('factDatasets')}
            value={String(receipt.datasetsInterned)}
          />
          <Fact
            label={t('factFieldsMasked')}
            value={String(receipt.fieldsMasked)}
          />
          <Fact
            label={t('factFieldsCleartext')}
            value={String(receipt.fieldsCleartext)}
          />
          <Fact
            label={t('factVerbs')}
            value={verbs.length > 0 ? verbs.join(', ') : t('verbsNone')}
          />
          <Fact
            label={t('factPseudonym')}
            value={
              receipt.pseudonymProjectionUsed
                ? t('pseudonymYes')
                : t('pseudonymNo')
            }
          />
          {(receipt.identityValuesOnWire ?? 0) > 0 && (
            <Fact
              label={t('factIdentityOnWire')}
              value={String(receipt.identityValuesOnWire)}
            />
          )}
        </dl>
        <div className={['text-[11px] italic', PALETTE.muted].join(' ')}>
          {t('explainer')}
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Single palette. v4 has no failure state in the receipt, so the card always
// reads as the "boundary active" state — emerald, byte5 brand.
// ---------------------------------------------------------------------------

const PALETTE = {
  container:
    'bg-emerald-50/60 ring-emerald-100 dark:bg-emerald-950/30 dark:ring-emerald-900/60',
  summary: 'text-emerald-800 dark:text-emerald-200',
  body: 'text-emerald-900 dark:text-emerald-100',
  label: 'text-emerald-700/80 dark:text-emerald-300/80',
  muted: 'text-emerald-900/80 dark:text-emerald-200/90',
} as const;

/**
 * Build the one-line summary shown in the collapsed card. Pure — pass a
 * translator so it stays unit-testable without React. `datasetsInterned` is
 * always ≥ 1 (the backend emits no receipt for a turn that interned nothing),
 * so the dataset clause always renders.
 */
export function summarisePrivacyReceipt(r: PrivacyReceipt, t: TFn): string {
  const parts: string[] = [
    t('summaryDatasets', { count: r.datasetsInterned }),
  ];
  if (r.fieldsMasked > 0) {
    parts.push(t('summaryMasked', { count: r.fieldsMasked }));
  }
  if (r.verbsExecuted.length > 0) {
    parts.push(t('summaryVerbs', { count: r.verbsExecuted.length }));
  }
  if (r.pseudonymProjectionUsed) {
    parts.push(t('summaryPseudonyms'));
  }
  const onWire = r.identityValuesOnWire ?? 0;
  if (onWire > 0) {
    parts.push(t('summaryIdentityOnWire', { count: onWire }));
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Inner renderer. Pure — no side effects, no IO.
// ---------------------------------------------------------------------------

interface FactProps {
  label: string;
  value: React.ReactNode;
}

function Fact({ label, value }: FactProps): React.ReactElement {
  return (
    <div className="contents">
      <dt
        className={[
          'text-[10px] font-semibold uppercase tracking-wider',
          PALETTE.label,
        ].join(' ')}
      >
        {label}
      </dt>
      <dd className="font-mono-num tabular-nums">{value}</dd>
    </div>
  );
}
