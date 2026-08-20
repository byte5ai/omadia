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

  const tone = result
    ? result.ok
      ? 'var(--success)'
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
            {result.ok
              ? result.checkpoints.signaturesChecked
                ? t('chainVerified', { n: result.checkedEntries })
                : t('chainVerifiedUnsigned', { n: result.checkedEntries })
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
          {!result.prefix.anchored ? <li>{t('chainUnanchoredPrefix')}</li> : null}
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
