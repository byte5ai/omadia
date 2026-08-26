'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { listMemoryContextLabels, type MemoryContextAxis } from '@/app/_lib/api';

import {
  CONTEXTS_ROOT,
  MEMORY_CONTEXT_AXES,
  ORCHESTRATORS_ROOT,
  agentTierRoot,
  basename,
  contextAxisRoot,
  contextTierRoot,
  decodeContextKey,
  type MemoryContextRef,
} from '../_lib/memoryPaths';

/**
 * Context dimension of the memory browser (design #870 §6).
 *
 * The tree is derived from the store itself — `/memories/orchestrators/*` for
 * the agent tier, `/memories/contexts/<slug>/<axis>/*` for the context tiers —
 * so it shows exactly what exists rather than what a registry believes exists.
 * Display names are an OPTIONAL enrichment: when nothing resolves a key, the
 * decoded `<channelType>~<nativeId>` is shown, which is still addressable.
 */

export interface DirEntry {
  virtualPath: string;
  isDirectory: boolean;
}

export type ListDir = (path: string) => Promise<DirEntry[]>;

export interface MemoryContextTreeProps {
  listDir: ListDir;
  /** Agent whose agent-tier root is currently browsed, if any. */
  activeAgentTier: string | null;
  activeContext: MemoryContextRef | null;
  onSelectAgentTier: (agentSlug: string) => void;
  onSelectContext: (ref: MemoryContextRef) => void;
}

type AxisKeys = Partial<Record<MemoryContextAxis, string[]>>;

function dirNames(entries: DirEntry[], parent: string): string[] {
  return entries
    .filter((e) => e.isDirectory && e.virtualPath !== parent)
    .map((e) => basename(e.virtualPath))
    .sort((a, b) => a.localeCompare(b));
}

export function MemoryContextTree({
  listDir,
  activeAgentTier,
  activeContext,
  onSelectAgentTier,
  onSelectContext,
}: MemoryContextTreeProps): React.ReactElement {
  const t = useTranslations('memory.contexts');
  const [agents, setAgents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [axisKeys, setAxisKeys] = useState<Record<string, AxisKeys>>({});
  const [labels, setLabels] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadAgents(): Promise<void> {
      try {
        // Both roots are optional: a store with no context trees yet has no
        // `contexts` directory at all, which the dev endpoint answers with a
        // 404 — that is an empty branch, not a failure of the whole tree.
        const [ctx, orch] = await Promise.all([
          listDir(CONTEXTS_ROOT).catch(() => [] as DirEntry[]),
          listDir(ORCHESTRATORS_ROOT).catch(() => [] as DirEntry[]),
        ]);
        if (cancelled) return;
        const merged = [
          ...new Set([
            ...dirNames(ctx, CONTEXTS_ROOT),
            ...dirNames(orch, ORCHESTRATORS_ROOT),
          ]),
        ].sort((a, b) => a.localeCompare(b));
        setAgents(merged);
        setExpanded(merged[0] ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadAgents();
    return () => {
      cancelled = true;
    };
  }, [listDir]);

  const loadAgentAxes = useCallback(
    async (slug: string): Promise<void> => {
      const perAxis = await Promise.all(
        MEMORY_CONTEXT_AXES.map(async (axis) => {
          const root = contextAxisRoot(slug, axis);
          const entries = await listDir(root).catch(() => [] as DirEntry[]);
          return [axis, dirNames(entries, root)] as const;
        }),
      );
      setAxisKeys((prev) => ({
        ...prev,
        [slug]: Object.fromEntries(perAxis) as AxisKeys,
      }));
      // Optional enrichment — a store without a name resolver stays usable.
      try {
        const res = await listMemoryContextLabels(slug);
        const map: Record<string, string> = {};
        for (const c of res.contexts) {
          if (c.displayName !== undefined && c.displayName.length > 0) {
            map[`${c.axis}/${c.ctxKey}`] = c.displayName;
          }
        }
        setLabels((prev) => ({ ...prev, [slug]: map }));
      } catch {
        setLabels((prev) => ({ ...prev, [slug]: {} }));
      }
    },
    [listDir],
  );

  useEffect(() => {
    if (expanded === null) return;
    if (expanded in axisKeys) return;
    // Lazy load-on-expand: the axes of an agent are only fetched once, and the
    // first state write happens after the awaits — not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAgentAxes(expanded);
  }, [expanded, axisKeys, loadAgentAxes]);

  const labelFor = (slug: string, axis: MemoryContextAxis, key: string): string => {
    const resolved = labels[slug]?.[`${axis}/${key}`];
    if (resolved !== undefined) return resolved;
    const decoded = decodeContextKey(key);
    return decoded === null ? key : `${decoded.channelType} · ${decoded.nativeId}`;
  };

  return (
    <div className="border-b border-[color:var(--border)] px-3 py-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
        {t('title')}
      </div>
      {loading && (
        <p className="text-[11px] text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}
      {error !== null && (
        <p className="text-[11px] text-[color:var(--danger)]">{t('error')}</p>
      )}
      {!loading && error === null && agents.length === 0 && (
        <p className="text-[11px] text-[color:var(--fg-muted)]">{t('empty')}</p>
      )}
      <ul className="flex flex-col gap-0.5">
        {agents.map((slug) => {
          const isOpen = expanded === slug;
          const axes = axisKeys[slug];
          return (
            <li key={slug}>
              {/* eslint-disable-next-line no-restricted-syntax -- tree disclosure row, not a text CTA */}
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => { setExpanded(isOpen ? null : slug); }}
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-left font-mono text-[11px] text-[color:var(--fg)] hover:bg-[color:var(--bg-soft)]"
              >
                <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                <span className="truncate">{slug}</span>
              </button>
              {isOpen && (
                <div className="ml-3 flex flex-col gap-0.5 border-l border-[color:var(--border)] pl-2">
                  {/* eslint-disable-next-line no-restricted-syntax -- tree selection row, not a text CTA */}
                  <button
                    type="button"
                    onClick={() => { onSelectAgentTier(slug); }}
                    aria-current={activeAgentTier === slug ? 'true' : undefined}
                    title={agentTierRoot(slug)}
                    className={[
                      'rounded px-1 py-1 text-left text-[11px]',
                      activeAgentTier === slug
                        ? 'bg-[color:var(--bg-soft)] text-[color:var(--fg-strong)]'
                        : 'text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]',
                    ].join(' ')}
                  >
                    {t('agentTier')}
                  </button>
                  {axes === undefined ? (
                    <span className="px-1 py-1 text-[11px] text-[color:var(--fg-muted)]">
                      {t('loading')}
                    </span>
                  ) : (
                    MEMORY_CONTEXT_AXES.map((axis) => {
                      const keys = axes[axis] ?? [];
                      return (
                        <div key={axis}>
                          <div className="px-1 pt-1 text-[10px] uppercase tracking-wider text-[color:var(--fg-subtle)]">
                            {t(`axis.${axis}`, { count: keys.length })}
                          </div>
                          {keys.map((key) => {
                            const isActive =
                              activeContext !== null &&
                              activeContext.agentSlug === slug &&
                              activeContext.axis === axis &&
                              activeContext.ctxKey === key;
                            return (
                              // eslint-disable-next-line no-restricted-syntax -- tree selection row, not a text CTA
                              <button
                                key={key}
                                type="button"
                                aria-current={isActive ? 'true' : undefined}
                                title={contextTierRoot({
                                  agentSlug: slug,
                                  axis,
                                  ctxKey: key,
                                })}
                                onClick={() => {
                                  onSelectContext({ agentSlug: slug, axis, ctxKey: key });
                                }}
                                className={[
                                  'block w-full truncate rounded px-1 py-1 text-left text-[11px]',
                                  isActive
                                    ? 'bg-[color:var(--bg-soft)] text-[color:var(--fg-strong)]'
                                    : 'text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]',
                                ].join(' ')}
                              >
                                {labelFor(slug, axis, key)}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
