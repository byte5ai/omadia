'use client';

import { useTranslations } from 'next-intl';

import type { EmbeddingGateState } from '../../_lib/api';

/**
 * The #440 gate verdict card of Admin → Embedding provider, with the tone
 * vocabulary the page shares. Split out of `page.tsx` to keep that file
 * within the size budget.
 */

/** Gate reasons that are progress reports, not failures. Both are published
 *  together with `vectorWritesAllowed: true`. */
const IN_PROGRESS_REASONS = new Set([
  'vector-columns-migrated',
  'stale-vector-clear-complete',
]);
const CLEAR_PENDING_REASON = 'stale-vector-clear-pending';

export type Tone = 'ok' | 'info' | 'warn' | 'error';

export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: 'border-[color:var(--border)] bg-[color:var(--card)]/40 text-[color:var(--fg-muted)]',
  info: 'border-[color:var(--accent)]/50 bg-[color:var(--accent)]/8 text-[color:var(--accent)]',
  warn: 'border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
  error:
    'border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 text-[color:var(--danger)]',
};

/** A blocked gate is red; a draining clear is amber; a finished migration or
 *  clear is blue-for-information — never red, because nothing is broken. */
function gateTone(gate: EmbeddingGateState): Tone {
  if (gate.reason !== undefined && IN_PROGRESS_REASONS.has(gate.reason)) {
    return 'info';
  }
  if (gate.reason === CLEAR_PENDING_REASON) return 'warn';
  return gate.vectorWritesAllowed ? 'ok' : 'error';
}

export function GatePanel({
  gate,
  card,
  heading,
  dt,
}: {
  gate: EmbeddingGateState | null;
  card: string;
  heading: string;
  dt: string;
}): React.ReactElement {
  const t = useTranslations('adminEmbeddingProvider');
  if (gate === null) {
    return (
      <section className={card}>
        <h2 className={heading}>{t('gateTitle')}</h2>
        <p className="text-sm text-[color:var(--fg-muted)]">
          {t('gateUnavailable')}
        </p>
      </section>
    );
  }
  const tone = gateTone(gate);
  return (
    <section className={`mb-6 rounded-lg border p-4 ${TONE_CLASS[tone]}`}>
      <h2 className={heading}>{t('gateTitle')}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className={dt}>{t('gateWrites')}</dt>
        <dd>
          {gate.vectorWritesAllowed
            ? t('gateWritesAllowed')
            : t('gateWritesBlocked')}
        </dd>
        <dt className={dt}>{t('gateStatus')}</dt>
        <dd className="font-mono">{gate.status}</dd>
        {gate.reason !== undefined && (
          <>
            <dt className={dt}>{t('gateReason')}</dt>
            <dd className="font-mono">{gate.reason}</dd>
          </>
        )}
        {gate.detail !== undefined && (
          <>
            <dt className={dt}>{t('gateDetail')}</dt>
            <dd>{gate.detail}</dd>
          </>
        )}
      </dl>
      {gate.reason === 'vector-columns-migrated' && (
        <p className="mt-3 text-sm">{t('gateMigrating')}</p>
      )}
      {gate.reason === 'stale-vector-clear-complete' && (
        <p className="mt-3 text-sm">{t('gateClearComplete')}</p>
      )}
      {gate.reason === CLEAR_PENDING_REASON && (
        <p className="mt-3 text-sm">{t('gateClearPending')}</p>
      )}
    </section>
  );
}
