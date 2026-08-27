'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { listMemoryContextLabels, type MemoryContextAxis } from '@/app/_lib/api';

import {
  CONTEXTS_ROOT,
  MEMORY_CONTEXT_AXES,
  basename,
  contextAxisRoot,
  contextTierRoot,
  type MemoryContextRef,
} from '../_lib/memoryPaths';

/**
 * Context dimension of the memory browser (design #870 §6).
 *
 * The tree is derived from the store itself — `/memories/contexts/<slug>/<axis>/*`
 * — so it shows exactly what exists rather than what a registry believes exists.
 * Display names are an OPTIONAL enrichment: when nothing resolves a key, the
 * `<channelType>~<safeKey>` context key is shown, which is the form the purge
 * selector accepts.
 *
 * SCOPE — contexts only, on purpose
 * ---------------------------------
 * `listDir` is now backed by `GET /bot-api/v1/operator/memory/contexts/list`
 * (`middleware/src/routes/operatorMemoryContexts.ts`), which is `requireAuth`-
 * gated and structurally unable to read outside `/memories/contexts`. It
 * replaces the unauthenticated `/bot-api/dev/memory/list`, which the memory
 * plugin only mounted behind `dev_memory_endpoints_enabled` — a flag the kernel
 * forbids in production, so this tree used to be dead precisely where an
 * operator needs it.
 *
 * The agent tier (`/memories/orchestrators/<slug>`) is consequently NOT a node
 * here any more: it lies outside the one subtree this gate can serve, and a
 * node that always errors is worse than an absent one. Promotion still targets
 * the agent tier — that is a write on the audited promote route, not a read.
 *
 * A non-404 failure still reaches the error state instead of rendering as an
 * empty tree, so an unreachable middleware or an expired session can never be
 * mistaken for "no context memory yet".
 */

export interface DirEntry {
  virtualPath: string;
  isDirectory: boolean;
}

export type ListDir = (path: string) => Promise<DirEntry[]>;

export interface MemoryContextTreeProps {
  listDir: ListDir;
  activeContext: MemoryContextRef | null;
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
  activeContext,
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
        // The root is optional — a store with no context trees yet has no
        // `contexts` directory at all — but that "optional" is the CALLER's
        // 404-to-empty rule, not a blanket catch here. Swallowing every
        // rejection would make the error state below unreachable, so a
        // middleware that is down or a 401 from an expired session would
        // render as "No agent memory yet" and an operator would conclude the
        // context trees do not exist. Let a real failure through.
        const ctx = await listDir(CONTEXTS_ROOT);
        if (cancelled) return;
        const merged = dirNames(ctx, CONTEXTS_ROOT).sort((a, b) =>
          a.localeCompare(b),
        );
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
    // Fall back to the key VERBATIM, not to a prettified half of it. The half
    // after `~` is a sanitised stem plus a digest, so rendering it alone reads
    // like a native id an operator could paste into the Danger-Zone selector —
    // where it would derive a different key and silently match nothing on a
    // destructive action. The full `channelType~safeKey` is exactly the form
    // that selector accepts, so showing it is both honest and directly usable.
    return key;
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
