'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { isFacilitatorAgent, listOperatorAgents, type OperatorAgentDto } from '../../../../_lib/agents';
import {
  deleteConsultationGrant,
  getAgentConsultation,
  parseConsultationErrorCode,
  putConsultationGrant,
  setConsultationSwitches,
  type AgentConsultationDto,
  type ConsultationGrantDto,
  type ConsultationGrantInput,
} from '../../../../_lib/consultation';
import { humanizeApiError } from '../../_components/AgentsDashboard';
import { AgentConsultationGrantForm, effectiveLevel } from './AgentConsultationGrantForm';

interface AgentConsultationProps {
  readonly agent: OperatorAgentDto;
}

/** Form state: closed, a new grant, or editing the grant to `to`. */
type FormState = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; grant: ConsultationGrantDto };

/**
 * Spec 2042 §5.4 (#2047) — consultation: may this agent ask a colleague for
 * a contribution, and may it be asked. Two switches plus directed grants
 * A → B; a grant names the capabilities B may use for A, whether B may draw
 * on its own memory (discreetly), how much B may disclose, and the budgets.
 * All default to off; a revoke takes effect on the next call. The list below
 * shows who may consult this agent (read-only; edited on the asking agent).
 */
export function AgentConsultation(props: AgentConsultationProps): React.ReactElement {
  const t = useTranslations('operatorAgents.consultation');
  const [state, setState] = useState<AgentConsultationDto | null>(null);
  const [agents, setAgents] = useState<OperatorAgentDto[]>([]);
  const [form, setForm] = useState<FormState>({ kind: 'closed' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseConsultationErrorCode(err);
      return code !== null ? t(`errors.${code}`) : t('errors.unknown', { detail: humanizeApiError(err) });
    },
    [t],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [consultation, list] = await Promise.all([getAgentConsultation(props.agent.slug), listOperatorAgents()]);
      setState(consultation);
      setAgents(list.agents);
      setError(null);
    } catch (err: unknown) {
      setError(localizeError(err));
    }
  }, [props.agent.slug, localizeError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        await refresh();
        return true;
      } catch (err: unknown) {
        setError(localizeError(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, localizeError],
  );

  const granted = new Set((state?.consults ?? []).map((g) => g.to));
  const targets = agents.filter(
    (a) => a.slug !== props.agent.slug && a.status === 'enabled' && !isFacilitatorAgent(a) && !granted.has(a.slug),
  );
  const nameOf = (slug: string): string => agents.find((a) => a.slug === slug)?.name ?? slug;

  const saveGrant = (to: string, input: ConsultationGrantInput): void => {
    void run(() => putConsultationGrant(props.agent.slug, to, input)).then((ok) => {
      if (ok) setForm({ kind: 'closed' });
    });
  };

  const describeGrant = (g: ConsultationGrantDto): string =>
    t('grantSummary', {
      capabilities: g.allowedCapabilities.length,
      memory: t(`memoryAccess.${g.memoryAccess}`),
      context: t(`disclosureLevels.${effectiveLevel(g.disclosure, 'context')}`),
      perTurn: g.maxCallsPerTurn,
      perDay: g.maxCallsPerDay,
    });

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
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

      {state === null && !error && <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>}

      {state !== null && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('heading')}</legend>
            {(['mayConsult', 'consultable'] as const).map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-start gap-2 rounded border border-[color:var(--border)]/60 p-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={state[key]}
                  disabled={busy}
                  onChange={(e) => void run(() => setConsultationSwitches(props.agent.slug, { [key]: e.target.checked }))}
                />
                <span>
                  <span className="font-medium text-[color:var(--fg-strong)]">{t(`switches.${key}`)}</span>
                  <span className="block text-xs text-[color:var(--fg-muted)]">{t(`switchHints.${key}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="mt-4">
            <h3 className="text-sm font-medium text-[color:var(--fg-strong)]">{t('consultsHeading')}</h3>
            <p className="mb-2 text-xs text-[color:var(--fg-muted)]">{t('consultsHint')}</p>
            {state.consults.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">{t('consultsEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {state.consults.map((g) => (
                  <li
                    key={g.to}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-[color:var(--border)]/60 px-2 py-1 text-sm"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span>{t('targetOption', { name: nameOf(g.to), slug: g.to })}</span>
                      <span className="text-xs text-[color:var(--fg-muted)]">{describeGrant(g)}</span>
                      {g.allowedCapabilities.length > 0 && (
                        <code className="break-all text-[10px] text-[color:var(--fg-muted)]">
                          {g.allowedCapabilities.join(', ')}
                        </code>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForm({ kind: 'edit', grant: g })}>
                        {t('edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void run(() => deleteConsultationGrant(props.agent.slug, g.to))}
                      >
                        {t('revoke')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {form.kind === 'closed' ? (
              <div className="mt-3">
                <Button size="sm" disabled={busy} onClick={() => setForm({ kind: 'new' })}>
                  {t('addGrant')}
                </Button>
              </div>
            ) : (
              <AgentConsultationGrantForm
                key={form.kind === 'edit' ? form.grant.to : 'new'}
                self={props.agent}
                targets={form.kind === 'edit' ? agents.filter((a) => a.slug === form.grant.to) : targets}
                editing={form.kind === 'edit' ? form.grant : null}
                busy={busy}
                onSubmit={saveGrant}
                onCancel={() => setForm({ kind: 'closed' })}
              />
            )}
          </div>

          <div className="mt-4">
            <h3 className="text-sm font-medium text-[color:var(--fg-strong)]">{t('consultedByHeading')}</h3>
            {state.consultedBy.length === 0 ? (
              <p className="text-sm text-[color:var(--fg-muted)]">{t('consultedByEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {state.consultedBy.map((g) => (
                  <li key={g.from} className="rounded border border-[color:var(--border)]/60 px-2 py-1 text-sm">
                    <span className="block">{t('targetOption', { name: nameOf(g.from), slug: g.from })}</span>
                    <span className="text-xs text-[color:var(--fg-muted)]">{describeGrant(g)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
