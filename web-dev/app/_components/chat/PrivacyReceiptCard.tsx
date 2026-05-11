'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type {
  PrivacyDetection,
  PrivacyDetectorRun,
  PrivacyDetectorStatus,
  PrivacyReceipt,
} from '../../_lib/chatSessions';

interface PrivacyReceiptCardProps {
  receipt: PrivacyReceipt;
  className?: string;
}

/**
 * Per-turn audit row showing what the `privacy.redact@1` provider did to
 * the outbound payload — detections, actions, routing decision. Mirror of
 * `<CaptureDisclosure>` at the disclosure-pattern layer (`<details>`,
 * collapsed by default, byte5 brand) but with privacy-specific severity
 * colour-coding driven off the worst action in the receipt.
 *
 * The receipt is PII-free by construction (see backend
 * `@omadia/plugin-api/privacyReceipt.ts`), so this component
 * renders it directly without any masking logic. If you find yourself
 * adding mask/strip code here, the receipt contract has been broken and
 * the regression is upstream.
 */

// `useTranslations` is a hook so we cannot call it from the pure helper
// functions below. The TFn alias captures the relevant signature and
// every helper takes it as an argument — this keeps the helpers easy to
// unit-test (pass a fake translator) without coupling them to React.
type TFn = (key: string, values?: Record<string, string | number>) => string;

export function PrivacyReceiptCard({
  receipt,
  className,
}: PrivacyReceiptCardProps): React.ReactElement {
  const t = useTranslations('privacyReceipt');
  const severity = computeSeverity(receipt);
  const palette = PALETTES[severity];

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
        {t('summary', { summary: summarise(receipt, t) })}
      </summary>
      <div
        className={[
          'space-y-2 px-2 pb-2 pt-1',
          palette.body,
        ].join(' ')}
      >
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <Fact label={t('factModus')} value={renderPolicyMode(receipt.policyMode, t)} palette={palette} />
          <Fact label={t('factRouting')} value={renderRouting(receipt.routing, t)} palette={palette} />
          {receipt.routingReason && (
            <Fact label={t('factReason')} value={receipt.routingReason} palette={palette} />
          )}
          <Fact
            label={t('factLatency')}
            value={`${String(receipt.latencyMs)} ms`}
            palette={palette}
          />
          <Fact
            label={t('factAuditId')}
            value={renderAuditId(receipt, t)}
            palette={palette}
          />
        </dl>
        {receipt.detections.length > 0 && (
          <div>
            <div
              className={[
                'text-[10px] font-semibold uppercase tracking-wider',
                palette.label,
              ].join(' ')}
            >
              {t('detectionsHeading', { count: receipt.detections.length })}
            </div>
            <ul className="mt-1 space-y-1">
              {receipt.detections.map((det, i) => (
                <li
                  key={`${det.type}-${det.action}-${String(i)}`}
                  className={['font-mono text-[11px]', palette.detection].join(' ')}
                >
                  • {renderDetection(det, t)}
                  {det.values && det.values.length > 0 && (
                    <ul className="mt-0.5 ml-4 space-y-0.5">
                      {det.values.map((v) => (
                        <li
                          key={`${det.type}-val-${v}`}
                          className={['font-mono text-[10px]', palette.detection].join(' ')}
                        >
                          ↳ <span className="bg-black/10 dark:bg-white/10 px-1 rounded">{v}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {receipt.detections.length === 0 && (
          <div className={['text-[11px] italic', palette.detection].join(' ')}>
            {hasDegradedRun(receipt)
              ? t('noDetectionsDegraded')
              : t('noDetectionsClean')}
          </div>
        )}
        {receipt.detectorRuns && receipt.detectorRuns.length > 0 && (
          <div>
            <div
              className={[
                'text-[10px] font-semibold uppercase tracking-wider',
                palette.label,
              ].join(' ')}
            >
              {t('detectorsHeading', { count: receipt.detectorRuns.length })}
            </div>
            <ul className="mt-1 space-y-0.5">
              {receipt.detectorRuns.map((run) => (
                <li
                  key={run.detector}
                  className={['font-mono text-[11px]', palette.detection].join(' ')}
                >
                  • {renderDetectorRun(run, t)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {receipt.debug === true && (
          <div
            className={[
              'rounded border px-2 py-1 text-[10px] font-semibold',
              'border-rose-300 bg-rose-50/60 text-rose-900',
              'dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-100',
            ].join(' ')}
          >
            {t('debugWarning')}
          </div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Severity → palette mapping. One source of truth so the summary badge,
// border, and detection-row colour all agree on what state we are in.
// ---------------------------------------------------------------------------

type Severity = 'green' | 'amber' | 'orange' | 'red';

interface Palette {
  readonly container: string;
  readonly summary: string;
  readonly body: string;
  readonly label: string;
  readonly detection: string;
}

const PALETTES: Readonly<Record<Severity, Palette>> = {
  green: {
    container:
      'bg-emerald-50/60 ring-emerald-100 dark:bg-emerald-950/30 dark:ring-emerald-900/60',
    summary: 'text-emerald-800 dark:text-emerald-200',
    body: 'text-emerald-900 dark:text-emerald-100',
    label: 'text-emerald-700/80 dark:text-emerald-300/80',
    detection: 'text-emerald-900/80 dark:text-emerald-200/90',
  },
  amber: {
    container:
      'bg-amber-50/60 ring-amber-100 dark:bg-amber-950/30 dark:ring-amber-900/60',
    summary: 'text-amber-800 dark:text-amber-200',
    body: 'text-amber-900 dark:text-amber-100',
    label: 'text-amber-700/80 dark:text-amber-300/80',
    detection: 'text-amber-900/80 dark:text-amber-200/90',
  },
  orange: {
    container:
      'bg-orange-50/60 ring-orange-100 dark:bg-orange-950/30 dark:ring-orange-900/60',
    summary: 'text-orange-800 dark:text-orange-200',
    body: 'text-orange-900 dark:text-orange-100',
    label: 'text-orange-700/80 dark:text-orange-300/80',
    detection: 'text-orange-900/80 dark:text-orange-200/90',
  },
  red: {
    container:
      'bg-rose-50/60 ring-rose-100 dark:bg-rose-950/30 dark:ring-rose-900/60',
    summary: 'text-rose-800 dark:text-rose-200',
    body: 'text-rose-900 dark:text-rose-100',
    label: 'text-rose-700/80 dark:text-rose-300/80',
    detection: 'text-rose-900/80 dark:text-rose-200/90',
  },
};

export function computeSeverity(receipt: PrivacyReceipt): Severity {
  if (receipt.routing === 'blocked') return 'red';
  let worst: Severity = 'green';
  for (const det of receipt.detections) {
    const s = severityForAction(det.action);
    if (rank(s) > rank(worst)) worst = s;
  }
  if (receipt.routing === 'local-llm' && rank(worst) < rank('amber')) {
    worst = 'amber';
  }
  // Slice 3.2.1: a detector that silently fail-opened (skipped/timeout/
  // error) bumps severity at least into amber, even if no detections
  // landed. Otherwise the green badge reads as "all clear" while the
  // detector never actually ran.
  if (hasDegradedRun(receipt)) {
    const bumped = severityForRunStatus(worstRunStatus(receipt));
    if (rank(bumped) > rank(worst)) worst = bumped;
  }
  return worst;
}

function hasDegradedRun(receipt: PrivacyReceipt): boolean {
  return (receipt.detectorRuns ?? []).some((r) => r.status !== 'ok');
}

function worstRunStatus(receipt: PrivacyReceipt): PrivacyDetectorStatus {
  let worst: PrivacyDetectorStatus = 'ok';
  for (const r of receipt.detectorRuns ?? []) {
    if (statusRank(r.status) > statusRank(worst)) worst = r.status;
  }
  return worst;
}

function statusRank(s: PrivacyDetectorStatus): number {
  switch (s) {
    case 'ok':
      return 0;
    case 'skipped':
      return 1;
    case 'timeout':
      return 2;
    case 'error':
      return 3;
  }
}

function severityForRunStatus(s: PrivacyDetectorStatus): Severity {
  switch (s) {
    case 'ok':
      return 'green';
    case 'skipped':
      return 'amber';
    case 'timeout':
      return 'orange';
    case 'error':
      return 'orange';
  }
}

function severityForAction(action: PrivacyDetection['action']): Severity {
  switch (action) {
    case 'passed':
      return 'green';
    case 'tokenized':
      return 'amber';
    case 'redacted':
      return 'orange';
    case 'blocked':
      return 'red';
  }
}

function rank(s: Severity): number {
  return s === 'green' ? 0 : s === 'amber' ? 1 : s === 'orange' ? 2 : 3;
}

// ---------------------------------------------------------------------------
// Inner renderers. Pure — no side effects, no IO.
// ---------------------------------------------------------------------------

function summarise(r: PrivacyReceipt, t: TFn): string {
  if (r.routing === 'blocked') {
    return t('summaryBlocked');
  }
  const degradedCount = (r.detectorRuns ?? []).filter((run) => run.status !== 'ok').length;
  const totalDetectors = (r.detectorRuns ?? []).length;
  const debugBadge = r.debug === true ? t('summaryDebugBadge') : '';

  if (r.detections.length === 0) {
    if (degradedCount > 0) {
      return `${debugBadge}${t('summaryDegraded', { degraded: degradedCount, total: totalDetectors })}`;
    }
    return `${debugBadge}${t('summaryActiveNoHits')}`;
  }
  const total = r.detections.reduce((acc, d) => acc + d.count, 0);
  const tokenized = r.detections
    .filter((d) => d.action === 'tokenized')
    .reduce((acc, d) => acc + d.count, 0);
  const redacted = r.detections
    .filter((d) => d.action === 'redacted')
    .reduce((acc, d) => acc + d.count, 0);
  const parts: string[] = [`${debugBadge}${t('summaryDetected', { count: total })}`];
  if (tokenized > 0) parts.push(t('summaryTokenized', { count: tokenized }));
  if (redacted > 0) parts.push(t('summaryRedacted', { count: redacted }));
  if (degradedCount > 0) parts.push(t('summarySkippedDetectors', { count: degradedCount }));
  if (r.routing === 'local-llm') parts.push(t('summaryLocalProcessed'));
  return parts.join(' · ');
}

function renderPolicyMode(mode: PrivacyReceipt['policyMode'], t: TFn): string {
  return mode === 'data-residency'
    ? t('policyDataResidency')
    : t('policyPiiShield');
}

function renderRouting(routing: PrivacyReceipt['routing'], t: TFn): string {
  switch (routing) {
    case 'public-llm':
      return t('routingPublic');
    case 'local-llm':
      return t('routingLocal');
    case 'blocked':
      return t('routingBlocked');
  }
}

function renderDetection(det: PrivacyDetection, t: TFn): string {
  const label = humanLabelForType(det.type, t);
  const action = humanLabelForAction(det.action, t);
  return `${label} ×${String(det.count)} → ${action}  ·  ${det.detector}`;
}

const TYPE_KEY_MAP: Readonly<Record<string, string>> = {
  'pii.email': 'typeEmail',
  'pii.iban': 'typeIban',
  'pii.phone': 'typePhone',
  'pii.credit_card': 'typeCreditCard',
  'pii.api_key': 'typeApiKey',
  // Slice 3.2 NER types from the Ollama detector vocabulary
  'pii.name': 'typeName',
  'pii.address': 'typeAddress',
  'pii.phone_de': 'typePhoneDe',
  'pii.id_number': 'typeIdNumber',
  'business.contract_clause': 'typeContractClause',
  'business.financial_data': 'typeFinancialData',
};

function humanLabelForType(type: string, t: TFn): string {
  const key = TYPE_KEY_MAP[type];
  return key ? t(key) : type;
}

function renderDetectorRun(run: PrivacyDetectorRun, t: TFn): string {
  const statusLabel = humanLabelForRunStatus(run.status);
  const callsLabel = t('callsCount', { count: run.callCount });
  const hitsLabel = t('hitsCount', { count: run.hitCount });
  const latencyLabel = `${String(run.latencyMs)} ms`;
  const parts = [run.detector, statusLabel, callsLabel, hitsLabel, latencyLabel];
  if (run.reason && run.reason.length > 0) {
    parts.push(run.reason);
  }
  return parts.join(' · ');
}

// Run statuses are technical/system-level (ok / skipped / timeout / error)
// and stay in English with universal icons — translating them would obscure
// the underlying log-level tags that match backend telemetry.
function humanLabelForRunStatus(status: PrivacyDetectorStatus): string {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'skipped':
      return '⏭ skipped';
    case 'timeout':
      return '⏱ timeout';
    case 'error':
      return '✖ error';
  }
}

function humanLabelForAction(action: PrivacyDetection['action'], t: TFn): string {
  switch (action) {
    case 'tokenized':
      return t('actionTokenized');
    case 'redacted':
      return t('actionRedacted');
    case 'blocked':
      return t('actionBlocked');
    case 'passed':
      return t('actionPassed');
  }
}

function renderAuditId(r: PrivacyReceipt, t: TFn): React.ReactNode {
  const short = r.receiptId.length > 22 ? `${r.receiptId.slice(0, 22)}…` : r.receiptId;
  return <CopyableSpan label={short} value={r.receiptId} ariaLabel={t('auditIdCopyAria')} />;
}

function CopyableSpan({
  label,
  value,
  ariaLabel,
}: {
  label: string;
  value: string;
  ariaLabel: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono">{label}</span>
      <button
        type="button"
        aria-label={ariaLabel}
        className="rounded px-1 text-[10px] underline-offset-2 hover:underline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            // Clipboard access can fail (insecure context, denied permission).
            // Falling silent here is fine — the user can still read the id.
          }
        }}
      >
        {copied ? '✓' : '📋'}
      </button>
    </span>
  );
}

interface FactProps {
  label: string;
  value: React.ReactNode;
  palette: Palette;
}

function Fact({ label, value, palette }: FactProps): React.ReactElement {
  return (
    <div className="contents">
      <dt
        className={[
          'text-[10px] font-semibold uppercase tracking-wider',
          palette.label,
        ].join(' ')}
      >
        {label}
      </dt>
      <dd className="font-mono-num tabular-nums">{value}</dd>
    </div>
  );
}
