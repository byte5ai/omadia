'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  classifyKnownTeamsTarget,
  TEAMS_TARGET_EXAMPLES,
  type KnownTeamsTarget,
  type TeamsTargetKind,
} from '@/app/_lib/teamsInstallTarget';
import type { AgentTeamsTargetsDto } from '@/app/_lib/agents';
import { TeamsTargetPicker } from './TeamsTargetPicker';

/**
 * "Which team or chat?", as one control — pick from the tenant, or type.
 *
 * ONE COMPONENT, TWO CALLERS, because the question is literally the same one
 * in both places: {@link AgentTeamsInstalls} asks it to add an install, and
 * the Teams identity panel asks it to give a target-less identity a target so
 * a run can start at all (the state a reset leaves behind). The copy, the
 * classification and the two ambiguity escapes have to agree between them —
 * an operator told "19:… is a channel id, not an install target" on one panel
 * and allowed to submit it on the other would be reading a bug.
 *
 * IT READS `operatorAgents.teamsInstalls` FOR THE TARGET COPY on purpose. That
 * namespace is where these sentences were written and where they belong: they
 * describe Teams install targets, not the panel that happens to render them.
 * Copying them into a second namespace would be two places to correct the day
 * Microsoft changes an id shape — the exact failure the sentences warn about.
 *
 * THE CLASSIFICATION IS GUIDANCE, NEVER AUTHORITY. The server re-decides on
 * every POST. What this buys is the five provisioning steps that used to run
 * before Graph answered `404 No team found with Group Id`: the verdict now
 * appears under the field while the operator is still typing.
 *
 * A PICKED TARGET IS NOT CLASSIFIED, IT IS REMEMBERED. When the id came from
 * the picker, Graph already said what it was, so the suffix table is not asked
 * — it is an approximation of an answer we were handed. That claim is bound to
 * the exact string it was made about ({@link KnownTeamsTarget}), so the first
 * keystroke in the field invalidates it and the classification takes over
 * again. The alternative — a remembered kind outliving the id it described —
 * would be the same lie as the misclassification, only quieter.
 *
 * THE KIND TRAVELS UP, NOT JUST ACROSS. `onChange` carries it to the caller so
 * it reaches the POST body as `target_kind`. Without that the middleware would
 * re-derive the kind from the id and land on the same wrong answer one hop
 * later, which is the failure mode this whole path exists to close.
 */

export interface TeamsTargetFieldProps {
  /** `null` covers BOTH "still loading" and "the directory failed" — see
   *  {@link TeamsTargetPicker}; either way the text field carries the load. */
  readonly targets: AgentTeamsTargetsDto | null;
  readonly targetsLoading: boolean;
  readonly value: string;
  /** `knownKind` is present only while `value` is exactly what the operator
   *  picked from the list; it is absent for anything typed. */
  readonly onChange: (value: string, knownKind?: TeamsTargetKind) => void;
  readonly disabled: boolean;
  /** The claim the caller is holding for `value`, echoed back so the verdict
   *  and the submit gate agree with what will actually be posted. */
  readonly known?: KnownTeamsTarget;
}

export function TeamsTargetField({
  targets,
  targetsLoading,
  value,
  onChange,
  disabled,
  known,
}: TeamsTargetFieldProps): React.JSX.Element {
  const t = useTranslations('operatorAgents.teamsInstalls');
  const target = classifyKnownTeamsTarget(value, known);

  return (
    <>
      {/* PICK first, TYPE second — and both write the same state, so the
          live classification below stays the single verdict. */}
      <TeamsTargetPicker
        targets={targets}
        loading={targetsLoading}
        disabled={disabled}
        value={value}
        onSelect={(id, kind) => onChange(id, kind)}
      />

      <label className="flex flex-col gap-1 text-[11px] text-[color:var(--fg-muted)]">
        {t('fieldTarget')}
        <input
          type="text"
          value={value}
          disabled={disabled}
          // No kind: typing is exactly the case the classifier was written
          // for, and a claim from an earlier pick must not survive an edit.
          onChange={(e) => onChange(e.target.value)}
          aria-label={t('fieldTarget')}
          className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 font-mono text-sm text-[color:var(--fg-strong)]"
        />
        <span>{t('fieldTargetHint')}</span>
        {/* Shown BEFORE anything is submitted: what a good answer looks
            like beats only being told the last one was wrong. */}
        <span className="font-mono text-[10px] opacity-70">
          {t('targetExamples', {
            team: TEAMS_TARGET_EXAMPLES.team,
            groupChat: TEAMS_TARGET_EXAMPLES.groupChat,
            legacyGroupChat: TEAMS_TARGET_EXAMPLES.legacyGroupChat,
          })}
        </span>
      </label>

      {/* The verdict. A recognised target is named — "Team" or
          "Gruppenchat" — so the operator can see the field understood
          them; the three that cannot be installed each say what to do.

          AND IT SAYS WHERE THE VERDICT CAME FROM. "Detected as" is a claim
          about a guess; for a row taken out of the tenant listing there was
          no guess, so it says "from the list" instead. The distinction is
          not decoration: it is the same one the code now makes, and a label
          that blurred it would describe a mechanism we deliberately stopped
          using. */}
      {target.kind === 'team' ||
      target.kind === 'group-chat' ||
      target.kind === 'one-on-one-chat' ? (
        <div className="text-[11px] text-[color:var(--success)]">
          {t(
            known !== undefined && known.id === value.trim()
              ? 'targetKindFromListLabel'
              : 'targetKindLabel',
            { kind: t(`targetKind.${target.kind}`) },
          )}
        </div>
      ) : null}
      {target.kind === 'channel' ? (
        <div role="alert" className="text-[11px] text-[color:var(--danger)]">
          {t('targetChannel')}
        </div>
      ) : null}
      {target.kind === 'unrecognised' ? (
        <div role="alert" className="text-[11px] text-[color:var(--danger)]">
          {t('targetUnrecognised')}
        </div>
      ) : null}
      {/* THE FIELD-TEST CASE. 32 hex digits are both a team id without
          its dashes and the stem of a group-chat id. Nothing is guessed:
          the operator is handed the two spellings and picks one, which
          is the only place the missing context actually exists. */}
      {target.kind === 'ambiguous' ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-[color:var(--border)] px-3 py-2">
          <span role="alert" className="text-[11px] text-[color:var(--fg-muted)]">
            {t('targetAmbiguous')}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(target.asTeamId)}
            >
              {t('targetAmbiguousUseTeam')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(target.asGroupChatId)}
            >
              {t('targetAmbiguousUseChat')}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
