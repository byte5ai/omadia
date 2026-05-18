'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

const KIND_BG: Record<PreviewPromptSection['kind'], string> = {
  header: 'bg-slate-50',
  persona: 'bg-amber-50',
  custom_notes: 'bg-amber-50/50',
  boundaries: 'bg-rose-50',
  sycophancy: 'bg-violet-50',
  skill: 'bg-emerald-50',
};

const KIND_LABEL: Record<PreviewPromptSection['kind'], string> = {
  header: 'Header',
  persona: 'Persona',
  custom_notes: 'Custom Notes',
  boundaries: 'Boundaries',
  sycophancy: 'Sycophancy',
  skill: 'Skill',
};

function tokenHealth(tokens: number): { color: string; label: string } {
  if (tokens < 2000) return { color: 'text-emerald-600', label: 'gut' };
  if (tokens < 3500) return { color: 'text-amber-600', label: 'mittel' };
  if (tokens < 5000) return { color: 'text-orange-600', label: 'hoch' };
  return { color: 'text-red-600', label: 'kritisch' };
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
          Preview Prompt
        </h3>
        <div className="flex items-center gap-2 text-xs">
          {data && (
            <span data-testid="preview-prompt-tokens" className={health!.color}>
              {data.tokens} Tokens ({health!.label})
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
            {loading ? 'Lade…' : 'Aktualisieren'}
          </button>
          <button
            type="button"
            data-testid="preview-prompt-copy"
            onClick={handleCopy}
            disabled={!data || loading}
            className="rounded border border-[color:var(--border)] px-2 py-1"
          >
            {copied ? 'Kopiert ✓' : 'Kopieren'}
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
            <span className="block text-[10px] font-semibold uppercase text-[color:var(--fg-muted)]">
              {KIND_LABEL[s.kind]}
            </span>
            {s.content}
          </pre>
        ))}
      </div>
    </section>
  );
}
