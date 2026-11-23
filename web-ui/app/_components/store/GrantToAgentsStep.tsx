'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '../ui/Button';
import {
  listAgentPluginCatalog,
  listOperatorAgents,
  STANDARD_ARCHETYPE,
  archetypeOfAgent,
  toggleAgentPlugin,
  type OperatorAgentDto,
  type PluginCatalogEntryDto,
} from '../../_lib/agents';
import { useBroadReachConfirm } from '../agents/useBroadReachConfirm';
import { ApiError } from '../../_lib/api';

type Phase =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'ready' }
  | { kind: 'granting' }
  | { kind: 'done'; granted: string[]; declined: string[] }
  | { kind: 'error'; detail: string }
  | { kind: 'loadError'; detail: string };

/**
 * #2054 — spec 2042 §5.2 / INV-8: installing a capability plugin grants it to
 * no agent; the install flow OFFERS it to the agents the operator picks.
 * Nothing is preselected and nothing happens without the choice.
 *
 * Shown after a Hub install, an upload, a store reinstall (the store's
 * post-install step) and a profile apply (the onboarding modal). Only for
 * capability plugins (the middleware's `capability` flag on the plugin
 * catalog); channels, models, archetypes and system modules never appear.
 * A plugin's installed `depends_on` parents are granted with it, as the
 * plugin editor on the agent page does.
 *
 * Each grant goes through `PATCH /v1/operator/agents/:slug/plugins`; one that
 * gives an agent access to every connected system asks for the explicit
 * confirmation first (`useBroadReachConfirm`).
 */
export function GrantToAgentsStep({
  pluginIds,
}: {
  pluginIds: readonly string[];
}): React.ReactElement | null {
  const t = useTranslations('agentReach.grant');
  const format = useFormatter();
  const router = useRouter();
  const broadReach = useBroadReachConfirm();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [catalog, setCatalog] = useState<PluginCatalogEntryDto[]>([]);
  const [agents, setAgents] = useState<OperatorAgentDto[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const idsKey = pluginIds.join('\n');

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgentPluginCatalog(), listOperatorAgents()])
      .then(([cat, list]) => {
        if (cancelled) return;
        setCatalog(cat.items);
        // Business capabilities go to standard agents; other archetypes
        // (the facilitator) deliberately hold none.
        setAgents(list.agents.filter((a) => archetypeOfAgent(a) === STANDARD_ARCHETYPE));
        const offered = cat.items.some((p) => p.capability === true && idsKey.split('\n').includes(p.id));
        setPhase(offered ? { kind: 'ready' } : { kind: 'hidden' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // No agent runtime yet (fresh install without an LLM access): there
        // is nobody to grant to, so the step stays away. Anything else is
        // said (#1880): nothing attaches a plugin automatically any more, so
        // a silently missing step would leave it with no agent at all.
        if (err instanceof ApiError && err.status === 503) {
          setPhase({ kind: 'hidden' });
          return;
        }
        setPhase({ kind: 'loadError', detail: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  const byId = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  const offeredPlugins = useMemo(
    () => pluginIds.map((id) => byId.get(id)).filter((p): p is PluginCatalogEntryDto => p?.capability === true),
    [byId, pluginIds],
  );
  /** The offered plugins plus their installed capability parents, parents first. */
  const grantIds = useMemo(() => {
    const out: string[] = [];
    const visit = (id: string): void => {
      if (out.includes(id)) return;
      const entry = byId.get(id);
      if (entry?.capability !== true) return;
      for (const parent of entry.depends_on) visit(parent);
      out.push(id);
    };
    for (const p of offeredPlugins) visit(p.id);
    return out;
  }, [byId, offeredPlugins]);

  if (phase.kind === 'loading' || phase.kind === 'hidden') return null;
  if (phase.kind === 'loadError') {
    return (
      <p role="alert" data-testid="grant-to-agents" className="text-[12px] text-[color:var(--danger)]">
        {t('loadFailed', { detail: phase.detail })}
      </p>
    );
  }

  const holdsAll = (agent: OperatorAgentDto): boolean =>
    offeredPlugins.every((p) => agent.plugins.some((row) => row.id === p.id && row.enabled));
  const names = format.list(offeredPlugins.map((p) => p.name));

  const toggle = (slug: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  const grant = async (): Promise<void> => {
    setPhase({ kind: 'granting' });
    const granted: string[] = [];
    const declined: string[] = [];
    try {
      for (const agent of agents.filter((a) => selected.has(a.slug))) {
        let completed = true;
        for (const pluginId of grantIds) {
          const result = await broadReach.guard(agent.name, (confirm) =>
            toggleAgentPlugin(agent.slug, pluginId, true, { confirmBroadReach: confirm }),
          );
          // The operator declined the broad-reach confirmation: stop here.
          if (result === undefined) {
            completed = false;
            break;
          }
        }
        (completed ? granted : declined).push(agent.name);
      }
      setSelected(new Set());
      setPhase({ kind: 'done', granted, declined });
      router.refresh();
    } catch (err) {
      setPhase({ kind: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const busy = phase.kind === 'granting';
  return (
    <section
      data-testid="grant-to-agents"
      className="rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] px-4 py-3"
    >
      {broadReach.dialog}
      <h3 className="text-[13px] font-semibold text-[color:var(--fg)]">{t('heading')}</h3>
      <p className="mt-1 text-[12px] text-[color:var(--fg-muted)]">{t('hint', { plugins: names })}</p>
      {agents.length === 0 ? (
        <p className="mt-2 text-[12px] text-[color:var(--fg-muted)]">{t('noAgents')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {agents.map((agent) => {
            const already = holdsAll(agent);
            return (
              <li key={agent.slug}>
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={already || selected.has(agent.slug)}
                    disabled={already || busy}
                    onChange={() => toggle(agent.slug)}
                  />
                  <span>{agent.name}</span>
                  {already ? (
                    <span className="text-[11px] text-[color:var(--fg-muted)]">{t('already')}</span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {agents.length > 0 ? (
        <div className="mt-3">
          <Button size="sm" disabled={busy || selected.size === 0} onClick={() => void grant()}>
            {busy ? t('submitting') : t('submit')}
          </Button>
        </div>
      ) : null}
      {phase.kind === 'done' && phase.granted.length > 0 ? (
        <p className="mt-2 text-[12px] text-[color:var(--fg)]">
          {t('done', { agents: format.list(phase.granted) })}
        </p>
      ) : null}
      {phase.kind === 'done' && phase.declined.length > 0 ? (
        <p className="mt-2 text-[12px] text-[color:var(--fg-muted)]">
          {t('declined', { agents: format.list(phase.declined) })}
        </p>
      ) : null}
      {phase.kind === 'error' ? (
        <p role="alert" className="mt-2 text-[12px] text-[color:var(--danger)]">
          {t('failed', { detail: phase.detail })}
        </p>
      ) : null}
    </section>
  );
}
