'use client';

import { ChevronLeft, ChevronRight, Loader2, RefreshCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchBuilderManifestPreview } from '../../../../_lib/api';
import { cn } from '../../../../_lib/cn';

interface ManifestDiffSidebarProps {
  draftId: string;
  /** Monotonic counter that increments after every spec_patch event.
   *  When this changes the sidebar refetches its preview. The parent
   *  Workspace owns the counter so multiple subscribers stay in sync. */
  refreshKey: number;
  /** Default-collapsed; the sidebar opens on click. The collapsed
   *  state survives across draft switches via prop, not localStorage,
   *  to keep state where it can be reasoned about. */
  collapsed: boolean;
  onToggle: (next: boolean) => void;
}

/**
 * B.11-9: Read-only manifest.yaml preview pinned to the right of the
 * SpecEditor pane. Refetches after every spec_patch event so the
 * operator sees the live result of their form edits.
 *
 * The actual codegen runs server-side via POST /manifest-preview;
 * client-side WASM-codegen would be ideal but lives in Node-only
 * boilerplate-source today (see codegen.ts loadBoilerplate).
 */
export function ManifestDiffSidebar({
  draftId,
  refreshKey,
  collapsed,
  onToggle,
}: ManifestDiffSidebarProps): React.ReactElement {
  const [yamlText, setYamlText] = useState<string>('');
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchedKey = useRef<number>(-1);

  const refresh = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const { manifest } = await fetchBuilderManifestPreview(draftId);
      setYamlText(manifest);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview-Fehler');
    } finally {
      setPending(false);
    }
  }, [draftId]);

  // Refetch when the sidebar is open and a new spec_patch ticks the
  // refreshKey (or on first open). Skipping while collapsed keeps the
  // route cheap when the operator never opens the panel.
  useEffect(() => {
    if (collapsed) return;
    if (refreshKey === lastFetchedKey.current) return;
    lastFetchedKey.current = refreshKey;
    void refresh();
  }, [collapsed, refreshKey, refresh]);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onToggle(false)}
        aria-label="Manifest-Vorschau öffnen"
        className="flex h-full w-6 flex-col items-center justify-center gap-1 border-l border-[color:var(--border)] bg-[color:var(--bg-soft)] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg-strong)]"
      >
        <ChevronLeft className="size-3" aria-hidden />
        <span className="rotate-90 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.18em]">
          manifest.yaml
        </span>
      </button>
    );
  }

  return (
    <aside className="flex h-full w-80 flex-col border-l border-[color:var(--border)] bg-[color:var(--bg-soft)]">
      <header className="flex items-center justify-between border-b border-[color:var(--border)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
            manifest.yaml
          </span>
          {pending ? (
            <Loader2 className="size-3 animate-spin text-[color:var(--fg-muted)]" aria-hidden />
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Manifest-Vorschau aktualisieren"
            className="rounded p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg)] hover:text-[color:var(--fg-strong)]"
          >
            <RefreshCcw className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onToggle(true)}
            aria-label="Manifest-Vorschau schließen"
            className="rounded p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg)] hover:text-[color:var(--fg-strong)]"
          >
            <ChevronRight className="size-3" aria-hidden />
          </button>
        </div>
      </header>
      {error ? (
        <p className="px-3 py-2 text-[11px] text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}
      <pre
        className={cn(
          'flex-1 overflow-auto px-3 py-2 font-mono-num text-[11px] leading-snug text-[color:var(--fg-strong)]',
          pending && 'opacity-60',
        )}
      >
        {yamlText || '# (Vorschau wird geladen)'}
      </pre>
    </aside>
  );
}
