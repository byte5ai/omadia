'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  fetchBuilderPreviewPrompt,
  type BuilderPreviewPrompt,
  type PreviewPromptSection,
} from '../../../../_lib/api';

/**
 * Issue #55 — live compiled-prompt preview panel.
 *
 * Subscribes to draft mutations via a manual refetch (parent passes
 * `refetchKey` from the SpecEventBus debounce). Renders the compiled
 * sections newest-first with per-section background highlighting, a
 * total token count with health indicator, and a Copy button.
 */

// Pastel section backgrounds carry their own explicit dark text color
// so they stay readable on a dark theme (without it, the page's light
// foreground inherits and the text disappears against the light pastel).
const KIND_BG: Record<PreviewPromptSection['kind'], string> = {
  header: 'bg-slate-50 text-slate-900',
  persona: 'bg-amber-50 text-amber-950',
  custom_notes: 'bg-amber-50/70 text-amber-950',
  boundaries: 'bg-rose-50 text-rose-950',
  sycophancy: 'bg-violet-50 text-violet-950',
  skill: 'bg-emerald-50 text-emerald-950',
};

const KIND_LABEL: Record<PreviewPromptSection['kind'], string> = {
  header: 'Header',
  persona: 'Persona',
  custom_notes: 'Custom Notes',
  boundaries: 'Boundaries',
  sycophancy: 'Sycophancy',
  skill: 'Skill',
};

type TokenHealthLevel = 'good' | 'medium' | 'high' | 'critical';

function tokenHealth(tokens: number): { color: string; level: TokenHealthLevel } {
  if (tokens < 2000) return { color: 'text-emerald-600', level: 'good' };
  if (tokens < 3500) return { color: 'text-amber-600', level: 'medium' };
  if (tokens < 5000) return { color: 'text-orange-600', level: 'high' };
  return { color: 'text-red-600', level: 'critical' };
}

export interface PreviewPromptPanelProps {
  draftId: string;
  /** Optional refetch trigger — bumping the value re-runs the fetch. */
  refetchKey?: number;
}

export function PreviewPromptPanel({
  draftId,
  refetchKey,
}: PreviewPromptPanelProps): React.ReactElement {
  const t = useTranslations('builder.preview.prompt');
  const [data, setData] = useState<BuilderPreviewPrompt | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBuilderPreviewPrompt(draftId);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  // First mount: fetch immediately so the panel never shows an empty
  // skeleton on tab-switch. Subsequent `refetchKey` bumps are 500 ms-
  // debounced — operator slider-saves come in bursts, debouncing keeps
  // the route calls bounded without losing per-edit feedback. (#55 AC:
  // "Prompt updates within ~500 ms after a persisted spec patch".)
  const initialLoadDoneRef = useRef(false);
  useEffect(() => {
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      void load();
      return;
    }
    const handle = setTimeout(() => {
      void load();
    }, 500);
    return () => {
      clearTimeout(handle);
    };
  }, [load, refetchKey]);

  const handleCopy = useCallback(async () => {
    if (!data) return;
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(data.systemPrompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* clipboard denied — silently ignore */
    }
  }, [data]);

  const health = data ? tokenHealth(data.tokens) : null;

  return (
    <section
      data-testid="preview-prompt-panel"
      className="space-y-2 rounded border border-[color:var(--border)] p-3"
    >
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[color:var(--fg-strong)]">
          {t('title')}
        </h3>
        <div className="flex items-center gap-2 text-xs">
          {data && (
            <span data-testid="preview-prompt-tokens" className={health!.color}>
              {t('tokens', {
                count: data.tokens,
                health: t(`health.${health!.level}`),
              })}
            </span>
          )}
          <button
            type="button"
            data-testid="preview-prompt-refresh"
            onClick={() => {
              void load();
            }}
            disabled={loading}
            className="rounded border border-[color:var(--border)] px-2 py-1"
          >
            {loading ? t('loading') : t('refresh')}
          </button>
          <button
            type="button"
            data-testid="preview-prompt-copy"
            onClick={handleCopy}
            disabled={!data || loading}
            className="rounded border border-[color:var(--border)] px-2 py-1"
          >
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="text-xs text-red-600" data-testid="preview-prompt-error">
          {error}
        </div>
      )}

      <div className="space-y-1 font-mono text-xs" data-testid="preview-prompt-sections">
        {data?.sections.map((s, i) => (
          <pre
            key={`${s.kind}-${String(i)}`}
            data-testid={`preview-prompt-section-${s.kind}`}
            className={`overflow-x-auto whitespace-pre-wrap rounded p-2 ${KIND_BG[s.kind]}`}
          >
            <span className="block text-[10px] font-semibold uppercase opacity-70">
              {KIND_LABEL[s.kind]}
            </span>
            {s.content}
          </pre>
        ))}
      </div>
    </section>
  );
}
