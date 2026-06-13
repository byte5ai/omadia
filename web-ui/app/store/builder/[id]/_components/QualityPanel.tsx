'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';

import {
  fetchBuilderQuality,
  type BuilderQualityResult,
  type QualitySuggestion,
} from '../../../../_lib/api';

/**
 * Issue #52 — quality score panel.
 *
 * Renders the 4 dimension bars (completeness / tokenEfficiency /
 * ruleQuality / specificity), the overall sweetspot, the token health
 * badge, and the suggestion list. Refresh button + auto-fetch on mount.
 */

function scoreColor(score: number): string {
  if (score >= 70) return 'bg-[color:var(--success)]/100';
  if (score >= 40) return 'bg-[color:var(--warning)]/100';
  return 'bg-[color:var(--danger)]/80';
}

export interface QualityPanelProps {
  draftId: string;
  /** Optional refetch trigger — bumping the value re-runs the fetch. */
  refetchKey?: number;
}

export function QualityPanel({ draftId, refetchKey }: QualityPanelProps): React.ReactElement {
  const t = useTranslations('builder.persona.quality');
  const dimensionLabel = (
    key: keyof BuilderQualityResult['dimensions'],
  ): string => t(`dimensions.${key}`);
  const sweetspotLabel = (s: BuilderQualityResult['sweetspot']): string =>
    t(`sweetspot.${s}`);
  const tokenHealthLabel = (tk: BuilderQualityResult['tokenHealth']): string =>
    t(`tokenHealth.${tk}`);
  const [data, setData] = useState<BuilderQualityResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBuilderQuality(draftId);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  useEffect(() => {
    // Fetch-on-mount / refetch: load() touches state only after the awaited
    // fetch — no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refetchKey]);

  return (
    <section
      data-testid="quality-panel"
      className="space-y-2 rounded border border-[color:var(--border)] p-3"
    >
      <header className="flex items-center justify-between">
        <button
          type="button"
          data-testid="quality-toggle"
          onClick={() => setExpanded((v) => !v)}
          className="text-sm font-semibold text-[color:var(--fg-strong)]"
          aria-expanded={expanded}
        >
          {t('heading')} {data ? `· ${data.score}/100` : ''} {expanded ? '▾' : '▸'}
        </button>
        <div className="flex items-center gap-2 text-xs">
          {data && (
            <span
              data-testid="quality-sweetspot"
              className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-0.5 text-[color:var(--fg)]"
            >
              {sweetspotLabel(data.sweetspot)}
            </span>
          )}
          {data && (
            <span
              data-testid="quality-token-health"
              className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-0.5 text-[color:var(--fg)]"
            >
              {t('tokensPrefix')} {tokenHealthLabel(data.tokenHealth)}
            </span>
          )}
          <button
            type="button"
            data-testid="quality-refresh"
            onClick={() => {
              void load();
            }}
            disabled={loading}
            className="rounded border border-[color:var(--border)] px-2 py-1"
          >
            {loading ? t('loading') : t('refresh')}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="text-xs text-[color:var(--danger)]" data-testid="quality-error">
          {error}
        </div>
      )}

      {expanded && data && (
        <>
          <div className="space-y-1" data-testid="quality-dimensions">
            {(['completeness', 'tokenEfficiency', 'ruleQuality', 'specificity'] as const).map(
              (key) => {
                const v = data.dimensions[key];
                return (
                  <div key={key} className="text-xs">
                    <div className="flex justify-between">
                      <span>{dimensionLabel(key)}</span>
                      <span>{v}/100</span>
                    </div>
                    <div className="h-1.5 w-full rounded bg-[color:var(--border)]">
                      <div
                        data-testid={`quality-bar-${key}`}
                        className={`h-full rounded ${scoreColor(v)}`}
                        style={{ width: `${v}%` }}
                      />
                    </div>
                  </div>
                );
              },
            )}
          </div>

          {data.suggestions.length > 0 && (
            <ul className="space-y-0.5 text-xs" data-testid="quality-suggestions">
              {data.suggestions.map((s: QualitySuggestion, i) => (
                <li
                  key={`${s.code}-${String(i)}`}
                  data-testid={`quality-suggestion-${s.code}`}
                  className="text-[color:var(--fg-muted)]"
                >
                  · {s.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
