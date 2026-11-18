'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  getAgentTeamsIdentity,
  parseTeamsIdentityErrorCode,
  type OperatorAgentDto,
} from '../../../_lib/agents';
import {
  facilitationEnginePluginId,
  loadFacilitationEngineStatus,
  type FacilitationEngineStatus,
} from '../../../_lib/facilitators';

/**
 * #2066 — is a facilitator ready to be added to a conversation?
 *
 * Three things have to be true, and each has its own fix:
 *
 *  1. IT HAS ITS OWN TEAMS IDENTITY. Owner decision (spec 2043 §0): a
 *     facilitator never speaks through another bot, so one without its own
 *     identity is "not ready", not "falls back to the default bot".
 *  2. A FACILITATION ENGINE IS USABLE: exactly one installed plugin declares
 *     `facilitationEngine@1`, the operator granted its SQL access, and it
 *     reports itself available. The kernel answers this on
 *     `GET /v1/operator/agents/facilitation-engine`.
 *  3. THAT ENGINE IS ATTACHED TO THIS FACILITATOR. The kernel attaches it by
 *     itself (at create, when an engine is installed or replaced, at boot),
 *     so a missing or switched-off row is a fault to repair, not a step the
 *     operator normally takes.
 */

/** How often an unready facilitator is re-checked while the page is open:
 *  provisioning finishes on its own, and the badge should follow. */
const READINESS_POLL_MS = 15_000;

export type FacilitatorTeamsState =
  | 'loading'
  | 'ready'
  | 'missing'
  | 'provisioning'
  | 'failed'
  /** The identity store / provisioner is not wired, or the read failed. */
  | 'unknown';

export function useFacilitatorTeamsState(slug: string): FacilitatorTeamsState {
  const [state, setState] = useState<FacilitatorTeamsState>('loading');

  const check = useCallback(async (): Promise<FacilitatorTeamsState> => {
    try {
      const status = await getAgentTeamsIdentity(slug);
      if (status.state === 'installed') return 'ready';
      return status.state === 'failed' ? 'failed' : 'provisioning';
    } catch (err: unknown) {
      return parseTeamsIdentityErrorCode(err) === 'teams_identity_not_found'
        ? 'missing'
        : 'unknown';
    }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const next = await check();
      if (cancelled) return;
      setState(next);
      if (next !== 'ready') timer = setTimeout(() => void tick(), READINESS_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [check]);

  return state;
}

export type FacilitationEngineLoad =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed' }
  | { readonly phase: 'loaded'; readonly status: FacilitationEngineStatus };

/** One read of the instance's engine status. `revision` re-runs it. */
export function useFacilitationEngine(revision = 0): FacilitationEngineLoad {
  const [load, setLoad] = useState<FacilitationEngineLoad>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadFacilitationEngineStatus()
      .then((status) => {
        if (!cancelled) setLoad({ phase: 'loaded', status });
      })
      .catch(() => {
        // The route is unreachable or predates the endpoint. That is "cannot tell",
        // which the notice says in its own words — it must not read as
        // "no engine installed".
        if (!cancelled) setLoad({ phase: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  return load;
}

/**
 * The facilitator's grant row for the instance's engine.
 *
 *  - `attached`: the row exists and is enabled — the normal case.
 *  - `disabled`: the row exists but was switched off. The kernel leaves an
 *    existing row alone, so it stays off until someone repairs it.
 *  - `missing`: no row, although an engine is installed.
 *  - `no_engine`: there is no single engine to attach (or it is not known).
 */
export type EngineGrantState = 'attached' | 'disabled' | 'missing' | 'no_engine';

export function engineGrantState(
  agent: Pick<OperatorAgentDto, 'plugins'>,
  engine: FacilitationEngineLoad,
): EngineGrantState {
  if (engine.phase !== 'loaded') return 'no_engine';
  const pluginId = facilitationEnginePluginId(engine.status);
  if (pluginId === null) return 'no_engine';
  const row = agent.plugins.find((p) => p.id === pluginId);
  if (!row) return 'missing';
  return row.enabled ? 'attached' : 'disabled';
}

const NOTICE_CLASS =
  'rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 p-3 text-sm text-[color:var(--warning)]';
const NOTICE_LINK_CLASS = 'ml-2 underline';

/**
 * The instance-wide notice: nothing while loading or when the engine is
 * ready, otherwise what is wrong and where to fix it.
 */
export function FacilitationEngineNotice(props: {
  readonly engine: FacilitationEngineLoad;
}): React.ReactElement | null {
  const t = useTranslations('operatorAgents.facilitator.engine');
  const { engine } = props;
  if (engine.phase === 'loading') return null;
  if (engine.phase === 'failed') {
    return (
      <div role="status" data-testid="facilitation-engine-notice" className={NOTICE_CLASS}>
        {t('loadFailed')}
      </div>
    );
  }
  const { status } = engine;
  if (status.state === 'ready') return null;
  return (
    <div
      role="status"
      data-testid="facilitation-engine-notice"
      data-engine-state={status.state}
      className={NOTICE_CLASS}
    >
      {status.state === 'none' && (
        <>
          {t('none')}
          <Link href="/store" className={NOTICE_LINK_CLASS}>
            {t('openStore')}
          </Link>
        </>
      )}
      {status.state === 'ambiguous' &&
        t('ambiguous', { plugins: status.pluginIds.join(', ') })}
      {status.state === 'ungranted' && (
        <>
          {t('ungranted', { plugin: status.pluginId })}
          <Link
            href={`/store/${encodeURIComponent(status.pluginId)}#grants`}
            className={NOTICE_LINK_CLASS}
          >
            {t('openGrants')}
          </Link>
        </>
      )}
      {status.state === 'unusable' && (
        <>
          {t(`unusable.${status.reason}`, { plugin: status.pluginId })}
          <Link
            href={`/store/${encodeURIComponent(status.pluginId)}`}
            className={NOTICE_LINK_CLASS}
          >
            {t('openPlugin')}
          </Link>
          {status.engineReason !== null && (
            // The plugin's own words are not ours to translate, so they are
            // not put into one of our sentences: a label, then the text as
            // the plugin wrote it.
            <span className="mt-2 block text-xs">
              <span className="block opacity-80">{t('engineReasonLabel')}</span>
              <q
                data-testid="facilitation-engine-reason"
                className="mt-0.5 block font-mono"
              >
                {status.engineReason}
              </q>
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** Link to the Teams tab of a facilitator's page — where provisioning lives. */
export function facilitatorTeamsHref(slug: string): string {
  return `/operator/agents/${encodeURIComponent(slug)}?tab=teams`;
}

/** Link to the engine tab of a facilitator's page. */
export function facilitatorEngineHref(slug: string): string {
  return `/operator/agents/${encodeURIComponent(slug)}?tab=engine`;
}

interface FacilitatorReadinessProps {
  readonly agent: Pick<OperatorAgentDto, 'slug' | 'plugins'>;
  readonly teams: FacilitatorTeamsState;
  readonly engine: FacilitationEngineLoad;
}

/**
 * "Ready" / "Not ready" with the open reasons, each linking to its fix.
 * While either read is still running it says so instead of guessing.
 */
export function FacilitatorReadiness(
  props: FacilitatorReadinessProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents.facilitator.readiness');
  const { agent, teams, engine } = props;

  if (teams === 'loading' || engine.phase === 'loading') {
    return (
      <p data-testid="facilitator-readiness" className="text-xs text-[color:var(--fg-muted)]">
        {t('checking')}
      </p>
    );
  }

  const engineReady = engine.phase === 'loaded' && engine.status.state === 'ready';
  const grant = engineGrantState(agent, engine);
  const ready = teams === 'ready' && engineReady && grant === 'attached';

  if (ready) {
    return (
      <p
        data-testid="facilitator-readiness"
        data-ready="true"
        className="text-xs font-medium text-[color:var(--success)]"
      >
        {t('ready')}
      </p>
    );
  }

  return (
    <div
      data-testid="facilitator-readiness"
      data-ready="false"
      className="text-xs text-[color:var(--warning)]"
    >
      <p className="font-medium">{t('notReady')}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {teams !== 'ready' && (
          <li data-testid="facilitator-readiness-teams">
            {t(`teams.${teams}`)}{' '}
            <Link href={facilitatorTeamsHref(agent.slug)} className="underline">
              {t('teamsLink')}
            </Link>
          </li>
        )}
        {!engineReady && (
          <li data-testid="facilitator-readiness-engine">{t('engineNotReady')}</li>
        )}
        {engineReady && (grant === 'missing' || grant === 'disabled') && (
          <li data-testid="facilitator-readiness-grant" data-grant-state={grant}>
            {t(grant === 'disabled' ? 'engineDisabled' : 'engineMissing')}{' '}
            <Link href={facilitatorEngineHref(agent.slug)} className="underline">
              {t('engineLink')}
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
}
