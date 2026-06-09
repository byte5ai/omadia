'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import {
  listOperatorAgents,
  type OperatorAgentDto,
} from '../../_lib/agents';

const BuilderCanvas = dynamic(() => import('./BuilderCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-[color:var(--fg-muted)]">
      …
    </div>
  ),
});

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; agents: OperatorAgentDto[] }
  | { kind: 'error'; message: string };

/**
 * Agent-Builder visual canvas (`/admin/builder`). Pick an agent, then wire
 * Channels → Agent → Sub-Agents → Skills → Tools/MCP plus a Schedule
 * trigger on an editable node-graph. The canvas itself is lazy-loaded
 * (ssr:false) to keep @xyflow out of the main bundle and avoid SSR issues.
 */
export default function BuilderPage(): React.ReactElement {
  const t = useTranslations('admin.builder');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await listOperatorAgents();
        if (!alive) return;
        setState({ kind: 'ready', agents: res.agents });
        const first = res.agents.length > 0 ? res.agents[0] : undefined;
        if (first) setSlug(first.slug);
      } catch (err) {
        if (!alive) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="flex h-[calc(100vh-var(--nav-h,64px))] flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-[color:var(--border)] px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-[color:var(--fg-strong)]">
            {t('title')}
          </h1>
          <p className="mt-0.5 text-[13px] text-[color:var(--fg-muted)]">
            {t('subtitle')}
          </p>
        </div>
        {state.kind === 'ready' && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-[color:var(--fg-muted)]">{t('agentPicker')}</span>
            <select
              value={slug ?? ''}
              onChange={(e) => setSlug(e.target.value || null)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--accent)]"
            >
              {state.agents.length === 0 && <option value="">—</option>}
              {state.agents.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="min-h-0 flex-1">
        {state.kind === 'loading' && (
          <p className="px-6 py-6 text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
        )}
        {state.kind === 'error' && (
          <p className="px-6 py-6 text-sm text-red-500">
            {t('loadError')}: {state.message}
          </p>
        )}
        {state.kind === 'ready' && slug && <BuilderCanvas slug={slug} />}
        {state.kind === 'ready' && !slug && (
          <p className="px-6 py-6 text-sm text-[color:var(--fg-muted)]">
            {t('noAgents')}
          </p>
        )}
      </div>
    </main>
  );
}
