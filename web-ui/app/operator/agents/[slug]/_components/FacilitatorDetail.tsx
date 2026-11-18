'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  parseOperatorAgentErrorCode,
  replaceAgentPlugins,
  type OperatorAgentDto,
} from '../../../../_lib/agents';
import { humanizeApiError } from '../../_components/AgentsDashboard';
import {
  FacilitationEngineNotice,
  FacilitatorReadiness,
  isEngineGranted,
  useFacilitationEngine,
  useFacilitatorTeamsState,
  type FacilitationEngineLoad,
} from '../../_components/facilitatorReadiness';
import { useFacilitatorRefusalMessage } from '../../_components/useFacilitatorCopy';
import { AgentDetailTabs } from './AgentDetailTabs';
import { AgentIdentity } from './AgentIdentity';
import { AgentModelPolicy } from './AgentModelPolicy';
import { AgentTeamsIdentity } from './AgentTeamsIdentity';
import { AgentTeamsInstalls } from './AgentTeamsInstalls';

/**
 * #2066 — the page of ONE facilitator (spec 2043 §2, §7).
 *
 * The same identity, model and Teams sections a standard agent has, because a
 * facilitator inherits what makes an agent a virtual employee. What it must
 * not have — plugin grants, tools and MCP servers, conversations with other
 * agents, memory, sub-agents, persona skills, schedules, being the default
 * agent — has no tab here at all: the kernel refuses each of them at write
 * time, so offering the control would only offer a refusal. One line says
 * why, so the missing tabs read as a decision and not as a bug.
 *
 * In place of the plugin editor there is ONE grant to make: the facilitation
 * engine, the single plugin a facilitator may hold.
 */
interface FacilitatorDetailProps {
  readonly agent: OperatorAgentDto;
}

export function FacilitatorDetail(
  props: FacilitatorDetailProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents.facilitator');
  const { agent } = props;
  // Bumped after the engine grant is written, so the status is read again.
  const [engineRevision, setEngineRevision] = useState(0);
  const engine = useFacilitationEngine(engineRevision);
  const teams = useFacilitatorTeamsState(agent.slug);

  return (
    <div className="space-y-6" data-testid="facilitator-detail">
      <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
        <p className="text-sm font-medium">{t('detail.kindHeading')}</p>
        <p
          data-testid="facilitator-omitted-note"
          className="mt-1 text-xs text-[color:var(--fg-muted)]"
        >
          {t('omittedNote')}
        </p>
        <div className="mt-3">
          <FacilitatorReadiness agent={agent} teams={teams} engine={engine} />
        </div>
      </div>

      <FacilitationEngineNotice engine={engine} />

      <AgentDetailTabs
        panels={{
          identity: () => <AgentIdentity slug={agent.slug} kind="facilitator" />,
          model: () => <AgentModelPolicy slug={agent.slug} />,
          teams: () => (
            <>
              <AgentTeamsIdentity slug={agent.slug} />
              <AgentTeamsInstalls slug={agent.slug} />
            </>
          ),
          engine: () => (
            <FacilitatorEnginePanel
              agent={agent}
              engine={engine}
              onGranted={() => setEngineRevision((r) => r + 1)}
            />
          ),
        }}
      />
    </div>
  );
}

function FacilitatorEnginePanel(props: {
  readonly agent: OperatorAgentDto;
  readonly engine: FacilitationEngineLoad;
  readonly onGranted: () => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents.facilitator.engine');
  const tError = useTranslations('operatorAgents');
  const router = useRouter();
  const refusalMessage = useFacilitatorRefusalMessage();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { agent, engine } = props;

  const plugin =
    engine.phase === 'loaded' &&
    (engine.status.state === 'ready' || engine.status.state === 'sql_grant_missing')
      ? engine.status.plugin
      : null;
  const granted = isEngineGranted(agent, engine);

  function grant(pluginId: string): void {
    setError(null);
    setBusy(true);
    // The engine is the ONLY grant a facilitator may hold, so the replace-set
    // is exactly that one row — any other row would be refused anyway.
    replaceAgentPlugins(agent.slug, [{ id: pluginId, enabled: true }])
      .then(() => {
        props.onGranted();
        startTransition(() => router.refresh());
      })
      .catch((err: unknown) => {
        const refusal = refusalMessage(err);
        const code = parseOperatorAgentErrorCode(err);
        setError(
          refusal ??
            (code !== null
              ? tError(`detailErrors.${code}`)
              : tError('detailErrors.unknown', { detail: humanizeApiError(err) })),
        );
      })
      .finally(() => setBusy(false));
  }

  return (
    <section
      data-testid="facilitator-engine-panel"
      className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4"
    >
      <h2 className="mb-1 text-lg font-medium">{t('heading')}</h2>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}

      {engine.phase === 'loading' && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}

      {engine.phase !== 'loading' && plugin === null && (
        // What is wrong with the engine is said once, in the notice above the
        // tabs; this panel only says that there is nothing to grant yet.
        <p className="text-sm text-[color:var(--fg-muted)]">{t('nothingToGrant')}</p>
      )}

      {plugin !== null && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-3 py-2 text-sm">
          <span className="font-medium">{plugin.name}</span>
          <code className="font-mono text-[10px] text-[color:var(--fg-muted)]">
            {plugin.id}
          </code>
          <Link
            href={`/store/${encodeURIComponent(plugin.id)}`}
            className="text-xs text-[color:var(--accent)] hover:underline"
          >
            {t('openPlugin')}
          </Link>
          <span className="ml-auto">
            {granted ? (
              <span
                data-testid="facilitator-engine-granted"
                className="text-xs font-medium text-[color:var(--success)]"
              >
                {t('granted')}
              </span>
            ) : (
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={busy || pending}
                onClick={() => grant(plugin.id)}
                data-testid="facilitator-engine-grant"
              >
                {busy ? t('granting') : t('grant')}
              </Button>
            )}
          </span>
        </div>
      )}
    </section>
  );
}
