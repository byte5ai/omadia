'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type {
  EmbeddingDedupThresholdProvenance,
  EmbeddingDedupThresholdResult,
  InstallableEmbeddingProvider,
} from '../../_lib/api';

/**
 * #1818 — what a reactivation or switch did about the knowledge graph's
 * dedup threshold. Renders nothing for the outcomes that changed nothing
 * worth saying (`unchanged`, `no-recommendation`, `no-knowledge-graph`).
 */
export function DedupThresholdMessage({
  result,
  testId,
}: {
  result: EmbeddingDedupThresholdResult | null | undefined;
  testId: string;
}): React.ReactElement | null {
  const t = useTranslations('adminEmbeddingProvider');
  if (!result) return null;
  let text: string | null = null;
  if (result.reason === 'applied') {
    text = t('dedupApplied', { value: result.value ?? 0 });
  } else if (result.reason === 'operator-set' && result.value !== null) {
    text = t('dedupOperatorSet', {
      current: result.previous ?? '',
      recommended: result.value,
    });
  } else if (result.reason === 'cleared') {
    text = t('dedupCleared', { previous: result.previous ?? '' });
  }
  if (text === null) return null;
  return (
    <p className="mt-1" data-testid={testId}>
      {text}
    </p>
  );
}

/** #1818 — the threshold's provenance, as one line of the current-state card. */
export function DedupThresholdProvenanceLine({
  provenance,
}: {
  provenance: EmbeddingDedupThresholdProvenance | null | undefined;
}): React.ReactElement | null {
  const t = useTranslations('adminEmbeddingProvider');
  if (!provenance) return null;
  const text =
    provenance.source === 'recommended'
      ? t('dedupProvenanceRecommended', {
          value: provenance.value ?? '',
          provider: provenance.recommendedBy ?? '',
        })
      : provenance.source === 'operator'
        ? t('dedupProvenanceOperator', { value: provenance.value ?? '' })
        : t('dedupProvenanceDefault');
  return (
    <p className="mt-1 text-xs text-[color:var(--fg-muted)]" data-testid="dedup-provenance">
      {text}
    </p>
  );
}

/**
 * #1814 — providers the store offers that are not installed. "Switch
 * provider" lists installed providers only, and the store refuses a second
 * one while one is active, so the page names them and the order of steps.
 */
export function InstallableProviders({
  providers,
  activeProviderId,
}: {
  providers: readonly InstallableEmbeddingProvider[] | undefined;
  activeProviderId: string | null;
}): React.ReactElement | null {
  const t = useTranslations('adminEmbeddingProvider');
  if (!providers || providers.length === 0) return null;
  return (
    <div className="mt-3 text-sm" data-testid="installable-providers">
      <p className="text-[color:var(--fg-muted)]">
        {activeProviderId === null
          ? t('installableIntroNoActive')
          : t('installableIntro', { active: activeProviderId })}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {providers.map((p) => (
          <li key={p.pluginId}>
            <Link
              href={`/store/${encodeURIComponent(p.pluginId)}`}
              className="text-[color:var(--accent)] hover:opacity-80"
            >
              {p.label}
            </Link>{' '}
            <span className="font-mono text-xs text-[color:var(--fg-muted)]">{p.pluginId}</span>
            {p.keyless && (
              <span className="ml-2 text-xs text-[color:var(--fg-muted)]">
                {t('installableKeyless')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
