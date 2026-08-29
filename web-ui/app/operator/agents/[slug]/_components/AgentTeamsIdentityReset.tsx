'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  resetAgentTeamsIdentity,
  type ResetAgentTeamsIdentityResponse,
  type TeamsResetStepDto,
} from '@/app/_lib/agents';

/**
 * Undo a Teams provisioning run — the destructive one.
 *
 * WHAT IT ACTUALLY DOES, which is why the confirmation is not a formality:
 * it deletes the agent's Entra app registration (delete AND recycle-bin
 * purge), its Azure bot service and the tenant catalog entry, then returns
 * the row to `pending`. `bot_slug` and `display_name` survive — they are the
 * only two fields a human typed, and keeping them is what makes the retry one
 * button with the same slug.
 *
 * THE CONFIRMATION FOLLOWS `AgentContextMemory`'s PATTERN, deliberately: an
 * inline consequences panel plus an acknowledgement checkbox that gates the
 * button. Not a `window.confirm`, which cannot list three things and cannot be
 * translated, and not a modal, which this codebase does not use for in-panel
 * actions. Two clicks minimum, and the first one only reveals what the second
 * would destroy.
 *
 * THE RESULT IS A PER-STEP REPORT, NOT A VERDICT. A teardown can genuinely
 * half-succeed — the catalog entry withdrawn, the app registration blocked
 * behind a connector that cannot purge — and "reset failed" as the only
 * signal is exactly what sends an operator into two Azure portals to find out
 * what is left. So every step renders with its own outcome, including the
 * ones that were skipped because there was nothing there.
 */

export interface AgentTeamsIdentityResetProps {
  readonly slug: string;
  /** The chain state the row is in — a `pending` identity has nothing to tear
   *  down and does not get the control at all. */
  readonly state: string;
  /** A run in flight. The server refuses in this case regardless; the button
   *  is disabled so the operator is not invited into a 409. */
  readonly running: boolean;
  readonly onDone: () => void;
}

/** Which outcomes are worth colouring as "attention". `blocked` is the loud
 *  one: nothing broke, but a human action is missing and the teardown stopped
 *  before it could make anything worse. */
function outcomeTone(outcome: TeamsResetStepDto['outcome']): string {
  if (outcome === 'failed') return 'text-[color:var(--danger)]';
  if (outcome === 'blocked') return 'text-[color:var(--warning,var(--danger))]';
  return 'text-[color:var(--fg-muted)]';
}

export function AgentTeamsIdentityReset({
  slug,
  state,
  running,
  onDone,
}: AgentTeamsIdentityResetProps): React.JSX.Element | null {
  const t = useTranslations('operatorAgents.teamsReset');
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ResetAgentTeamsIdentityResponse | null>(
    null,
  );

  // A row that never provisioned anything has nothing to remove, and offering
  // a destructive control that would be a no-op only teaches operators that
  // the scary button is harmless.
  if (state === 'pending') return null;

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await resetAgentTeamsIdentity(slug);
      setReport(res);
      setOpen(false);
      setAcknowledged(false);
      onDone();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded border border-[color:var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
          {t('heading')}
        </span>
        <div className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            disabled={running || busy}
            onClick={() => setOpen((prev) => !prev)}
          >
            {open ? t('cancel') : t('open')}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
        {running ? t('runningHint') : t('hint')}
      </p>

      {open && (
        <div
          role="note"
          className="mt-3 rounded border border-[color:var(--border)] bg-[color:var(--bg)] p-3 text-xs"
        >
          <p className="mb-2 font-medium text-[color:var(--fg-strong)]">
            {t('confirmHeading')}
          </p>
          {/* Named one by one rather than as "all Azure resources". An
              operator approving a deletion is entitled to the list. */}
          <ul className="mb-2 flex list-disc flex-col gap-1 pl-4 text-[color:var(--fg-muted)]">
            <li>{t('consequenceApp')}</li>
            <li>{t('consequenceBot')}</li>
            <li>{t('consequenceCatalog')}</li>
            <li>{t('consequenceInstalls')}</li>
          </ul>
          {/* The reassuring half, and it is load-bearing: knowing the slug
              survives is what tells the operator this is a retry, not a
              restart from a blank form. */}
          <p className="mb-3 text-[color:var(--fg-muted)]">{t('keepsHint')}</p>
          <label className="mb-3 flex cursor-pointer items-start gap-2 text-[color:var(--fg-strong)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              disabled={busy}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>{t('acknowledge')}</span>
          </label>
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            busyLabel={t('busy')}
            disabled={!acknowledged || busy || running}
            onClick={() => void run()}
          >
            {t('confirm')}
          </Button>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="mt-2 text-[11px] text-[color:var(--danger)]">
          {error}
        </p>
      )}

      {report !== null && (
        <div className="mt-3 text-xs" data-testid="teams-reset-report">
          <p
            className={
              report.status === 'reset'
                ? 'font-medium text-[color:var(--fg-strong)]'
                : 'font-medium text-[color:var(--danger)]'
            }
          >
            {report.status === 'reset'
              ? t('resultComplete')
              : t('resultIncomplete', {
                  step: t(`steps.${report.stoppedAt ?? 'identity_reset'}`),
                })}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {report.steps.map((step) => (
              <li key={step.step} className={outcomeTone(step.outcome)}>
                {t('stepLine', {
                  step: t(`steps.${step.step}`),
                  outcome: t(`outcomes.${step.outcome}`),
                })}
                {step.detail !== undefined && step.detail !== '' && (
                  <span className="ml-1 opacity-80">
                    {t.has(`details.${step.detail}`)
                      ? t(`details.${step.detail}`)
                      : step.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
