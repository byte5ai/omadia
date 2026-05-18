'use client';

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

const DIMENSION_LABEL_DE: Record<keyof BuilderQualityResult['dimensions'], string> = {
  completeness: 'Vollständigkeit',
  tokenEfficiency: 'Token-Effizienz',
  ruleQuality: 'Regel-Qualität',
  specificity: 'Spezifität',
};

function scoreColor(score: number): string {
  if (score >= 70) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}

function sweetspotLabelDe(s: BuilderQualityResult['sweetspot']): string {
  if (s === 'under') return 'unterversorgt';
  if (s === 'over') return 'überfrachtet';
  return 'Sweet Spot';
}

function tokenHealthLabelDe(t: BuilderQualityResult['tokenHealth']): string {
  if (t === 'warning') return 'Warnung';
  if (t === 'critical') return 'kritisch';
  return 'OK';
}

export interface QualityPanelProps {
  draftId: string;
  /** Optional refetch trigger — bumping the value re-runs the fetch. */
  refetchKey?: number;
}

export function QualityPanel({ draftId, refetchKey }: QualityPanelProps): React.ReactElement {
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
          Quality {data ? `· ${data.score}/100` : ''} {expanded ? '▾' : '▸'}
        </button>
        <div className="flex items-center gap-2 text-xs">
          {data && (
            <span
              data-testid="quality-sweetspot"
              className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-0.5 text-[color:var(--fg)]"
            >
              {sweetspotLabelDe(data.sweetspot)}
            </span>
          )}
          {data && (
            <span
              data-testid="quality-token-health"
              className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-0.5 text-[color:var(--fg)]"
            >
              Tokens: {tokenHealthLabelDe(data.tokenHealth)}
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
            {loading ? 'Lade…' : 'Aktualisieren'}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="text-xs text-red-600" data-testid="quality-error">
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
                      <span>{DIMENSION_LABEL_DE[key]}</span>
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
