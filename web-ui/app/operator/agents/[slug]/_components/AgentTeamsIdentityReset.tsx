'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  resetAgentTeamsIdentity,
  type ResetAgentTeamsIdentityResponse,
  type TeamsResetScope,
  type TeamsResetStepDto,
} from '@/app/_lib/agents';

/**
 * Undo a Teams provisioning run — the destructive controls.
 *
 * TWO WAYS BACK, AND THEY ARE NOT THE SAME SIZE. Both delete the agent's
 * Entra app registration (delete AND recycle-bin purge), its Azure bot
 * service and the tenant catalog entry. They differ in what happens to the
 * identity afterwards:
 *
 *   * RESET THE RUN keeps `bot_slug` and `display_name` — the only two fields
 *     a human typed — and returns the row to `pending`. The retry is one
 *     button with the same name. This is what an operator wants when a run
 *     died in the middle.
 *   * DELETE THE IDENTITY removes the row as well, so the agent has no Teams
 *     identity at all and the create form comes back empty. `bot_slug` is
 *     `UNIQUE`, so this is the ONLY way to free a name — which is what an
 *     operator wants when the identity itself was the mistake.
 *
 * TELLING THEM APART IS THIS COMPONENT'S REAL JOB. They sit side by side with
 * different labels, and the confirmations are deliberately unequal:
 *
 *   * the milder one is gated by a checkbox, as it always was;
 *   * the destructive one ALSO requires the operator to type the bot slug.
 *     Typing the name of the thing you are about to make unrecoverable is the
 *     one confirmation a person cannot perform by reflex, and it is
 *     proportionate here precisely because this is the button that throws
 *     away answers a human gave rather than identifiers Azure handed back.
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
  /** The bot slug the operator has to type to confirm the destructive
   *  variant — and the value that variant exists to set free. */
  readonly botSlug: string;
  /** The chain state the row is in. A `pending` identity has nothing in Azure
   *  to tear down, so it is offered only the identity deletion. */
  readonly state: string;
  /** A run in flight. The server refuses in this case regardless; the buttons
   *  are disabled so the operator is not invited into a 409. */
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
  botSlug,
  state,
  running,
  onDone,
}: AgentTeamsIdentityResetProps): React.JSX.Element | null {
  const t = useTranslations('operatorAgents.teamsReset');
  const [open, setOpen] = useState<TeamsResetScope | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedSlug, setTypedSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ResetAgentTeamsIdentityResponse | null>(
    null,
  );

  // A row that never provisioned anything has nothing in Azure to remove, so
  // the RUN reset would be a no-op — and a scary button that does nothing
  // only teaches operators that scary buttons are harmless.
  //
  // The identity deletion is a different matter and stays offered: the row
  // still holds a UNIQUE bot slug, and an operator who typed a name they
  // regret before ever starting a run has no other way to free it.
  const offersRunReset = state !== 'pending';

  function closePanel(): void {
    setOpen(null);
    setAcknowledged(false);
    setTypedSlug('');
  }

  async function run(scope: TeamsResetScope): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await resetAgentTeamsIdentity(slug, scope);
      setReport(res);
      closePanel();
      onDone();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggle(scope: TeamsResetScope): void {
    // Opening the other variant REPLACES the panel rather than stacking a
    // second one, so there is never a moment where two confirmations with
    // different consequences are both on screen.
    setOpen((prev) => (prev === scope ? null : scope));
    setAcknowledged(false);
    setTypedSlug('');
  }

  const slugConfirmed = typedSlug.trim() === botSlug;
  const destructive = open === 'identity';
  const armed = acknowledged && (!destructive || slugConfirmed);

  return (
    <div className="mt-3 rounded border border-[color:var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
          {t('heading')}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {offersRunReset && (
            <Button
              size="sm"
              variant="ghost"
              disabled={running || busy}
              onClick={() => toggle('run')}
            >
              {open === 'run' ? t('cancel') : t('openRun')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={running || busy}
            onClick={() => toggle('identity')}
          >
            {open === 'identity' ? t('cancel') : t('openIdentity')}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
        {running ? t('runningHint') : t('hint')}
      </p>

      {open !== null && (
        <div
          role="note"
          data-testid={`teams-reset-confirm-${open}`}
          className="mt-3 rounded border border-[color:var(--border)] bg-[color:var(--bg)] p-3 text-xs"
        >
          <p className="mb-2 font-medium text-[color:var(--fg-strong)]">
            {destructive ? t('confirmHeadingIdentity') : t('confirmHeading')}
          </p>
          {/* Named one by one rather than as "all Azure resources". An
              operator approving a deletion is entitled to the list. */}
          <ul className="mb-2 flex list-disc flex-col gap-1 pl-4 text-[color:var(--fg-muted)]">
            <li>{t('consequenceApp')}</li>
            <li>{t('consequenceBot')}</li>
            <li>{t('consequenceCatalog')}</li>
            <li>{t('consequenceInstalls')}</li>
            {/* The extra thing the destructive variant throws away, spelled
                out as its own bullet because it is the ONLY difference and
                burying it in a paragraph is how the two get confused. */}
            {destructive && <li>{t('consequenceIdentity')}</li>}
          </ul>
          {/* The half that says what SURVIVES. Load-bearing in both
              directions: for the run reset it tells the operator this is a
              retry rather than a restart from a blank form, and for the
              identity deletion it tells them the blank form is the point. */}
          <p className="mb-3 text-[color:var(--fg-muted)]">
            {destructive ? t('dropsHint') : t('keepsHint')}
          </p>
          <label className="mb-3 flex cursor-pointer items-start gap-2 text-[color:var(--fg-strong)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              disabled={busy}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>{destructive ? t('acknowledgeIdentity') : t('acknowledge')}</span>
          </label>
          {/* THE SECOND GATE, and only on the destructive variant. A checkbox
              can be ticked without reading; the slug has to be read off the
              panel above and typed. */}
          {destructive && (
            <label className="mb-3 flex flex-col gap-1 text-[color:var(--fg-strong)]">
              <span>{t('slugConfirmLabel', { slug: botSlug })}</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 font-mono text-[color:var(--fg-strong)]"
                value={typedSlug}
                disabled={busy}
                onChange={(e) => setTypedSlug(e.target.value)}
              />
              {typedSlug !== '' && !slugConfirmed && (
                <span className="text-[color:var(--danger)]">
                  {t('slugMismatch')}
                </span>
              )}
            </label>
          )}
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            busyLabel={t('busy')}
            disabled={!armed || busy || running}
            onClick={() => void run(open)}
          >
            {destructive ? t('confirmIdentity') : t('confirmRun')}
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
              ? report.scope === 'identity'
                ? t('resultCompleteIdentity')
                : t('resultComplete')
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
