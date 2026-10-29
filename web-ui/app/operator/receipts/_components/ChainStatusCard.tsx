'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '../../../_components/ui/Button';
import {
  getProvenancePublicKey,
  provenanceExportUrl,
  verifyProvenance,
  type ProvenancePublicKeyDto,
  type ProvenanceVerifyDto,
} from '../../../_lib/provenance';

interface ChainStatusCardProps {
  initialKey: ProvenancePublicKeyDto | null;
}

/**
 * #761 — chain-status card on the receipts page: posture (key configured,
 * checkpoint cadence, anchor), an on-demand verify run, and the signed
 * export download the offline verifier consumes. State via text/edge color
 * only, per Lume.
 */
export function ChainStatusCard({ initialKey }: ChainStatusCardProps): React.ReactElement {
  const t = useTranslations('operatorReceipts');
  const [keyInfo, setKeyInfo] = useState<ProvenancePublicKeyDto | null>(initialKey);
  const [result, setResult] = useState<ProvenanceVerifyDto | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle');

  async function runVerify(): Promise<void> {
    setState('running');
    try {
      const [verify, key] = await Promise.all([verifyProvenance(), getProvenancePublicKey()]);
      setResult(verify);
      setKeyInfo(key);
      setState('idle');
    } catch {
      setState('error');
    }
  }

  // #1568 — `unsigned` is consistent but unverifiable: never the success tone.
  const tone = result
    ? result.verdict === 'verified'
      ? 'var(--success)'
      : result.verdict === 'unsigned'
        ? 'var(--warning)'
        : 'var(--danger)'
    : 'var(--fg-muted)';

  return (
    <section
      className="mb-6 rounded border p-4"
      style={{ borderColor: tone }}
      aria-label={t('chainHeading')}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold" style={{ color: tone }}>
          {t('chainHeading')}
        </h2>
        {result ? (
          <span className="font-mono text-xs" style={{ color: tone }}>
            {result.verdict === 'verified'
              ? t('chainVerified', { n: result.checkedEntries })
              : result.verdict === 'unsigned'
                ? t('chainUnsigned', { n: result.checkedEntries })
                : t('chainBroken')}
          </span>
        ) : (
          <span className="text-xs text-[color:var(--fg-muted)]">{t('chainNotYetVerified')}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <a
            className="text-xs underline decoration-dotted"
            href={provenanceExportUrl()}
            download
          >
            {t('chainExport')}
          </a>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            busy={state === 'running'}
            busyLabel={t('chainVerifying')}
            onClick={() => void runVerify()}
          >
            {t('chainVerifyNow')}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
        {keyInfo?.configured
          ? t('chainKeyConfigured', {
              fingerprint: keyInfo.fingerprint?.slice(0, 16) ?? '',
              minutes: keyInfo.checkpointIntervalMinutes,
            })
          : t('chainKeyMissing')}
        {keyInfo?.anchorConfigured ? ` · ${t('chainAnchorOn')}` : ''}
      </p>
      {result && !result.ok ? (
        <ul className="mt-2 list-inside list-disc text-xs" style={{ color: tone }}>
          {result.breakKind ? (
            <li>
              {t('chainBreakAt', { kind: result.breakKind, seq: result.firstBrokenSeq ?? 0 })}
            </li>
          ) : null}
          {result.checkpoints.findings.map((f) => (
            <li key={`${f.kind}-${String(f.seq)}`}>
              {t('chainCheckpointFinding', { kind: f.kind, seq: f.seq })}
            </li>
          ))}
          {result.anchor.findings.map((f) => (
            <li key={`anchor-${f.kind}-${String(f.seq)}`}>
              {t('chainAnchorFinding', { kind: f.kind, seq: f.seq })}
            </li>
          ))}
          {!result.prefix.anchored && !result.prefix.unanchoredReason ? (
            <li>{t('chainUnanchoredPrefix')}</li>
          ) : null}
          {result.prefix.prematureDeletion ? (
            <li>
              {t('chainPrematureDeletion', {
                provenAfter: result.prefix.prematureDeletion.provenCreatedAfterIso,
                days: result.prefix.prematureDeletion.retentionDays,
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
      {result ? <ChainNotes result={result} /> : null}
      {result && result.preChainRows > 0 ? (
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">
          {t('chainPreChainRows', { n: result.preChainRows })}
        </p>
      ) : null}
      {state === 'error' ? (
        <p className="mt-2 text-xs text-[color:var(--danger)]">{t('chainVerifyFailed')}</p>
      ) : null}
    </section>
  );
}

/** Information that never turns the verdict red on its own: a keyless
 *  retention prefix, unchecked checkpoints, the anchor comparison status. */
function ChainNotes({ result }: { result: ProvenanceVerifyDto }): React.ReactElement | null {
  const t = useTranslations('operatorReceipts');
  const notes: string[] = [];
  if (result.prefix.unanchoredReason === 'no_signing_key' && result.prefix.reapedUpToSeq > 0) {
    notes.push(t('chainPrefixUnsigned', { seq: result.prefix.reapedUpToSeq }));
  }
  if (result.checkpoints.unchecked > 0) {
    notes.push(t('chainCheckpointsUnchecked', { n: result.checkpoints.unchecked }));
  }
  if (result.anchor.configured) {
    if (result.anchor.status === 'missing') notes.push(t('chainAnchorMissing'));
    else if (result.anchor.status === 'unreadable') notes.push(t('chainAnchorUnreadable'));
    else {
      notes.push(
        t('chainAnchorCompared', { matched: result.anchor.matched, records: result.anchor.records }),
      );
    }
  }
  if (notes.length === 0) return null;
  return (
    <ul className="mt-1 list-inside list-disc text-xs text-[color:var(--fg-muted)]">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
