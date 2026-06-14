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
 * this component renders it directly without any masking logic.
 *
 * Severity: the card reads calm emerald by default. When the requester named
 * a real personal identity in their own request — `identityValuesOnWire > 0`,
 * i.e. a real name reached the model — the WHOLE card switches to red so the
 * transparency notice is impossible to miss.
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
  const bypassed = receipt.bypassedTools ?? [];

  // Palette precedence: identity-breach (red) wins over bypass-warning
  // (amber) wins over default (emerald). Breach is a transparency notice
  // the user MUST see; bypass is a conscious operator decision but still
  // worth highlighting; default is the boring "boundary did its job".
  const breached = (receipt.identityValuesOnWire ?? 0) > 0;
  const hasBypass = bypassed.length > 0;
  const palette = breached
    ? PALETTE_BREACH
    : hasBypass
      ? PALETTE_BYPASS
      : PALETTE_OK;

  // Which explainer line to show under the facts grid. Bypass explainer
  // is its own line BELOW the default/breach explainer because they can
  // co-occur (a turn can both intern AND bypass).
  const explainerKey = breached ? 'explainerBreach' : 'explainer';

  return (
    <details
      className={[
        'mt-2 rounded text-xs ring-1',
        palette.container,
        className ?? '',
      ].join(' ')}
    >
      <summary
        className={[
          'cursor-pointer select-none px-2 py-1 font-medium',
          palette.summary,
        ].join(' ')}
      >
        {t('summary', { summary: summarisePrivacyReceipt(receipt, t) })}
      </summary>
      <div className={['space-y-2 px-2 pb-2 pt-1', palette.body].join(' ')}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <Fact
            label={t('factDatasets')}
            value={String(receipt.datasetsInterned)}
            labelClass={palette.label}
          />
          <Fact
            label={t('factFieldsMasked')}
            value={String(receipt.fieldsMasked)}
            labelClass={palette.label}
          />
          <Fact
            label={t('factFieldsCleartext')}
            value={String(receipt.fieldsCleartext)}
            labelClass={palette.label}
          />
          <Fact
            label={t('factVerbs')}
            value={verbs.length > 0 ? verbs.join(', ') : t('verbsNone')}
            labelClass={palette.label}
          />
          <Fact
            label={t('factPseudonym')}
            value={
              receipt.pseudonymProjectionUsed
                ? t('pseudonymYes')
                : t('pseudonymNo')
            }
            labelClass={palette.label}
          />
          {breached && (
            <Fact
              label={t('factIdentityOnWire')}
              value={String(receipt.identityValuesOnWire)}
              labelClass={palette.label}
            />
          )}
        </dl>
        {hasBypass && (
          <div>
            <div
              className={[
                'text-[10px] font-semibold uppercase tracking-wider',
                palette.label,
              ].join(' ')}
            >
              {t('factBypassed')}
            </div>
            <ul className="mt-1 space-y-0.5">
              {bypassed.map((entry, i) => (
                <li
                  key={`${entry.pluginId}-${entry.toolName}-${String(i)}`}
                  className="font-mono-num flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="font-medium">{entry.toolName}</span>
                  <span className={palette.label}>{entry.pluginId}</span>
                  <span className={['text-[10px]', palette.label].join(' ')}>
                    {t('bypassedBytes', {
                      kb: (entry.bytes / 1024).toFixed(1),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className={['text-[11px] italic', palette.muted].join(' ')}>
          {t(explainerKey)}
        </div>
        {hasBypass && (
          <div className={['text-[11px] italic', palette.muted].join(' ')}>
            {t('explainerBypassed')}
          </div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Two palettes. Emerald = the calm "boundary did its job" default. Red = the
// requester named a real identity that reached the model — surfaced loud.
// ---------------------------------------------------------------------------

const PALETTE_OK = {
  container:
    'bg-[color:var(--success)]/10 ring-[color:var(--success)]',
  summary: 'text-[color:var(--success)]',
  body: 'text-[color:var(--success)]',
  label: 'text-[color:var(--success)]/80',
  muted: 'text-[color:var(--success)]/80',
} as const;

const PALETTE_BREACH = {
  container:
    'bg-[color:var(--danger)]/8 ring-[color:var(--danger-edge)]',
  summary: 'font-semibold text-[color:var(--danger)]',
  body: 'text-[color:var(--danger)]',
  label: 'text-[color:var(--danger)]/80',
  muted: 'text-[color:var(--danger)]/80',
} as const;

// Slice 2.5 — operator opted into bypass on at least one plugin this turn.
// Amber sits between calm-emerald (boundary did its job) and loud-red (real
// identity reached the model). Bypass is a conscious choice, but the user
// should still see it loud enough to notice.
const PALETTE_BYPASS = {
  container:
    'bg-[color:var(--warning)]/10 ring-[color:var(--warning)]',
  summary: 'font-medium text-[color:var(--warning)]',
  body: 'text-[color:var(--warning)]',
  label: 'text-[color:var(--warning)]/80',
  muted: 'text-[color:var(--warning)]/80',
} as const;

/**
 * Build the one-line summary shown in the collapsed card. Pure — pass a
 * translator so it stays unit-testable without React. `datasetsInterned` is
 * always ≥ 1 (the backend emits no receipt for a turn that interned nothing),
 * so the dataset clause always renders.
 */
export function summarisePrivacyReceipt(r: PrivacyReceipt, t: TFn): string {
  const parts: string[] = [];
  // Slice 2.5: drop the dataset clause entirely when the turn interned
  // nothing (pure-bypass turn) — the receipt now also surfaces for those.
  if (r.datasetsInterned > 0) {
    parts.push(t('summaryDatasets', { count: r.datasetsInterned }));
  }
  if (r.fieldsMasked > 0) {
    parts.push(t('summaryMasked', { count: r.fieldsMasked }));
  }
  if (r.verbsExecuted.length > 0) {
    parts.push(t('summaryVerbs', { count: r.verbsExecuted.length }));
  }
  if (r.pseudonymProjectionUsed) {
    parts.push(t('summaryPseudonyms'));
  }
  const bypassed = r.bypassedTools ?? [];
  if (bypassed.length > 0) {
    parts.push(t('summaryBypassed', { count: bypassed.length }));
  }
  const onWire = r.identityValuesOnWire ?? 0;
  if (onWire > 0) {
    // Lead with the breach clause so it is the first thing read.
    parts.unshift(t('summaryIdentityOnWire', { count: onWire }));
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Inner renderer. Pure — no side effects, no IO.
// ---------------------------------------------------------------------------

interface FactProps {
  label: string;
  value: React.ReactNode;
  labelClass: string;
}

function Fact({ label, value, labelClass }: FactProps): React.ReactElement {
  return (
    <div className="contents">
      <dt
        className={[
          'text-[10px] font-semibold uppercase tracking-wider',
          labelClass,
        ].join(' ')}
      >
        {label}
      </dt>
      <dd className="font-mono-num tabular-nums">{value}</dd>
    </div>
  );
}
