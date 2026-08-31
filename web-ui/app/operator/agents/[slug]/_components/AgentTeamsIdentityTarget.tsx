'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { isSubmittableTarget, classifyTeamsInstallTarget } from '@/app/_lib/teamsInstallTarget';
import {
  getAgentTeamsTargets,
  type AgentTeamsTargetsDto,
} from '@/app/_lib/agents';
import { TeamsTargetField } from './TeamsTargetField';

/**
 * The way back into a run for an identity that HAS no install target.
 *
 * THE DEAD END THIS REMOVES. A reset returns the row to `pending` and nulls
 * `team_id` — deliberately, because the team the operator was aiming at is no
 * longer a commitment once the app registration, the bot and the catalogue
 * entry have been torn down. But the panel had exactly two ways to start a
 * run and neither survived that: the create form renders only when NO identity
 * row exists, and "provision again" is disabled without a recorded target
 * (the POST requires `team_id` and the server has no re-run-as-recorded path).
 * So a reset produced a panel reading "PENDING", every field empty, and not
 * one control that could start anything. The only remaining move was deleting
 * the agent.
 *
 * THE CONDITION IS "NO TARGET", NOT "WAS RESET". Nothing here can observe a
 * reset, and it must not try: a row can reach the same shape by other routes —
 * an identity created before `team_id` existed, a partial write, a future
 * re-target flow that clears the field first. The state is what is renderable,
 * so the state is what this is keyed on.
 *
 * `bot_slug` AND `display_name` ARE NOT ASKED AGAIN. They survive a reset on
 * purpose — they are the only two fields a human typed — and re-asking would
 * turn a retry into a fresh form, invite a slug change nobody wanted, and
 * contradict the reset panel's own promise that they are kept. Only the target
 * is missing, so only the target is asked for.
 */

export interface AgentTeamsIdentityTargetProps {
  readonly slug: string;
  /** A provisioning POST is in flight from the parent panel. */
  readonly busy: boolean;
  /** The runner is holding a run for this agent. Starting a second one is
   *  refused server-side, so the control says so instead of inviting a 409. */
  readonly running: boolean;
  readonly onStart: (teamId: string) => void;
}

export function AgentTeamsIdentityTarget({
  slug,
  busy,
  running,
  onStart,
}: AgentTeamsIdentityTargetProps): React.JSX.Element {
  const t = useTranslations('operatorAgents.teamsIdentity');
  const [teamId, setTeamId] = useState('');
  const [targets, setTargets] = useState<AgentTeamsTargetsDto | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(true);

  // Loaded once per agent, mirroring `AgentTeamsInstalls`: a tenant's teams
  // and chats do not change while somebody fills in a form, and this panel
  // polls every three seconds — re-enumerating on each poll would spend the
  // connector's Graph budget on a list nobody is looking at any more.
  useEffect(() => {
    let cancelled = false;
    setTargetsLoading(true);
    void getAgentTeamsTargets(slug)
      .then((dto) => {
        if (!cancelled) setTargets(dto);
      })
      .catch(() => {
        // Swallowed on purpose: the text field works without a directory, and
        // an error banner for a failed convenience would read as though the
        // restart itself were broken — which is the very thing being fixed.
        if (!cancelled) setTargets(null);
      })
      .finally(() => {
        if (!cancelled) setTargetsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const submittable = isSubmittableTarget(classifyTeamsInstallTarget(teamId));
  const locked = busy || running;

  return (
    <div
      data-testid="teams-identity-target"
      className="flex flex-col gap-2 rounded border border-[color:var(--border)] p-3"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--fg-muted)]">
        {t('retarget.heading')}
      </div>
      <p className="text-xs text-[color:var(--fg-muted)]">
        {running ? t('retarget.runningHint') : t('retarget.hint')}
      </p>

      <TeamsTargetField
        targets={targets}
        targetsLoading={targetsLoading}
        value={teamId}
        onChange={setTeamId}
        disabled={locked}
      />

      <div>
        <Button
          size="sm"
          busy={busy}
          disabled={locked || !submittable}
          busyLabel={t('submitBusy')}
          onClick={() => onStart(teamId.trim())}
        >
          {t('submit')}
        </Button>
      </div>
    </div>
  );
}
