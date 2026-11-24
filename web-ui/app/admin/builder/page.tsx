'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/app/_components/ui/Button';

import {
  isFacilitatorAgent,
  listOperatorAgents,
  type OperatorAgentDto,
  type OperatorAgentsListDto,
} from '../../_lib/agents';
import { NewAgentDialog } from './NewAgentDialog';

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
  | { kind: 'ready'; agents: OperatorAgentDto[]; hasFacilitators: boolean }
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

  const [creating, setCreating] = useState(false);

  /** Shows the agents; `select` picks one (a just-created agent), else the
   *  current pick stays or the first one is taken. */
  const show = useCallback((res: OperatorAgentsListDto, select?: string): void => {
    // #2066 — a facilitator has nothing to wire on the canvas: channel
    // bindings, sub-agents, tools, MCP servers and schedules are each
    // refused by the kernel for the kind. It is not offered here.
    const wireable = res.agents.filter((a) => !isFacilitatorAgent(a));
    setState({
      kind: 'ready',
      agents: wireable,
      hasFacilitators: wireable.length < res.agents.length,
    });
    setSlug((current) => select ?? current ?? wireable[0]?.slug ?? null);
  }, []);

  const failed = (err: unknown): void =>
    setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });

  useEffect(() => {
    let alive = true;
    listOperatorAgents()
      .then((res) => {
        if (alive) show(res);
      })
      .catch((err: unknown) => {
        if (alive) failed(err);
      });
    return () => {
      alive = false;
    };
  }, [show]);

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
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              data-testid="builder-new-agent"
              onClick={() => setCreating(true)}
            >
              {t('newAgent.open')}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-[color:var(--fg-muted)]">{t('agentPicker')}</span>
              <select
                value={slug ?? ''}
                onChange={(e) => setSlug(e.target.value || null)}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
              >
                {state.agents.length === 0 && <option value="">—</option>}
                {state.agents.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </header>
      {creating && (
        <NewAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            listOperatorAgents()
              .then((res) => show(res, created))
              .catch(failed);
          }}
        />
      )}

      <div className="min-h-0 flex-1">
        {state.kind === 'loading' && (
          <p className="px-6 py-6 text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
        )}
        {state.kind === 'error' && (
          <p className="px-6 py-6 text-sm text-[color:var(--danger)]">
            {t('loadError')}: {state.message}
          </p>
        )}
        {state.kind === 'ready' && state.hasFacilitators && (
          <p
            data-testid="builder-facilitators-note"
            className="border-b border-[color:var(--border)] px-6 py-2 text-xs text-[color:var(--fg-muted)]"
          >
            {t('facilitatorsNote')}
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
