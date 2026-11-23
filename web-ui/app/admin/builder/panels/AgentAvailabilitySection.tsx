'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { AgentAvailabilityEditor } from '@/app/_components/agents/AgentAvailabilityEditor';
import { setAgentAvailability, type AgentAvailability } from '../../../_lib/agentAvailability';
import { listOperatorAgents } from '../../../_lib/agents';
import { SaveButton } from './InspectorControls';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'error'; detail: string }
  | { kind: 'missing' }
  | { kind: 'ready'; value: AgentAvailability };

/**
 * Spec 2042 — who may reach this agent, on the agent node of the Agent
 * Builder inspector. Read from the agent directory, saved through `PUT
 * /operator/agents/:slug/availability`.
 */
export function AgentAvailabilitySection({ slug }: { slug: string }): React.ReactElement {
  const t = useTranslations('admin.builder.availability');
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    listOperatorAgents()
      .then((res) => {
        if (!alive) return;
        const availability = res.agents.find((a) => a.slug === slug)?.availability;
        setLoaded(availability ? { kind: 'ready', value: availability } : { kind: 'missing' });
      })
      .catch((err: unknown) => {
        if (alive)
          setLoaded({
            kind: 'error',
            detail: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  const save = async (value: AgentAvailability): Promise<void> => {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await setAgentAvailability(slug, value);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-testid="builder-availability">
      <p className="text-[13px] font-semibold text-[color:var(--fg-strong)]">{t('title')}</p>
      {loaded.kind === 'loading' && (
        <p className="text-xs text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}
      {loaded.kind === 'error' && (
        <p role="alert" className="text-xs text-[color:var(--danger)]">
          {t('loadError', { detail: loaded.detail })}
        </p>
      )}
      {loaded.kind === 'missing' && (
        <p
          className="text-xs text-[color:var(--fg-muted)]"
          data-testid="builder-availability-missing"
        >
          {t('notReported')}
        </p>
      )}
      {loaded.kind === 'ready' && (
        <>
          <AgentAvailabilityEditor
            value={loaded.value}
            onChange={(value) => {
              setSaved(false);
              setLoaded({ kind: 'ready', value });
            }}
            disabled={pending}
          />
          {error && (
            <p role="alert" className="text-xs text-[color:var(--danger)]">
              {t('saveError', { detail: error })}
            </p>
          )}
          {saved && <p className="text-xs text-[color:var(--fg-muted)]">{t('saved')}</p>}
          <SaveButton onClick={() => void save(loaded.value)} pending={pending} label={t('save')} />
        </>
      )}
    </section>
  );
}
