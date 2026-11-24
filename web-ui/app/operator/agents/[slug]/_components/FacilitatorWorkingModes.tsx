'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  addPersonaSkill,
  getAgentGraph,
  listSkills,
  removePersonaSkill,
  type SkillNode,
} from '../../../../_lib/agentBuilder';
import { parseFacilitatorRefusal, type FacilitatorContractIssue } from '../../../../_lib/facilitators';
import { useFacilitatorIssueText } from '../../_components/useFacilitatorCopy';

/**
 * #2060 — a facilitator's working modes (spec 2043 §2.3). Modes that add a
 * moderation method are allowed; per turn at most one is chosen and composed
 * beneath the facilitator's identity and its neutrality contract. The kernel
 * refuses a mode that would change who speaks, contradict the neutrality
 * contract or bring tools; the refusal's findings are shown here.
 */
export function FacilitatorWorkingModes(props: { readonly slug: string }): React.ReactElement {
  const t = useTranslations('operatorAgents.facilitator.workingModes');
  const issueText = useFacilitatorIssueText();
  const [skills, setSkills] = useState<readonly SkillNode[] | null>(null);
  const [attached, setAttached] = useState<readonly string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<readonly FacilitatorContractIssue[]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [graph, list] = await Promise.all([getAgentGraph(props.slug), listSkills()]);
      setAttached(graph.agent.personaSkillIds ?? []);
      setSkills(list.skills);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [props.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadFailed) {
    return (
      <p role="alert" className="text-sm text-[color:var(--danger)]">
        {t('loadFailed')}
      </p>
    );
  }
  if (!skills) return <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>;

  const byId = new Map(skills.map((s) => [s.id, s]));
  const available = skills.filter((s) => !attached.includes(s.id));

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setIssues([]);
    setFailed(false);
    try {
      await action();
      setChoice('');
      await load();
    } catch (err: unknown) {
      const refusal = parseFacilitatorRefusal(err);
      // One line per rule and place: the kernel may report the same rule
      // twice for one text (e.g. a new name and speaking as someone else).
      if (refusal?.kind === 'contract') {
        setIssues(refusal.issues.filter((issue, i, all) => all.findIndex((o) => o.rule === issue.rule && o.path === issue.path) === i));
      }
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="facilitator-working-modes" className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{t('heading')}</h3>
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('intro')}</p>
      </div>
      {attached.length === 0 ? (
        <p className="text-xs text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        <ul className="space-y-1">
          {attached.map((id) => (
            <li key={id} className="flex items-center gap-2 text-sm" data-testid="facilitator-working-mode">
              <span>{byId.get(id)?.name ?? id}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => removePersonaSkill(props.slug, id))}
              >
                {t('remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <label className="block text-sm">
          <span className="block">{t('addLabel')}</span>
          <select
            data-testid="facilitator-working-mode-select"
            className="mt-1 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">{t('choose')}</option>
            {available.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={busy || choice === ''}
          data-testid="facilitator-working-mode-add"
          onClick={() => void run(() => addPersonaSkill(props.slug, choice))}
        >
          {t('add')}
        </Button>
      </div>
      {issues.length > 0 && (
        <div role="alert" data-testid="facilitator-working-mode-refused" className="text-xs text-[color:var(--danger)]">
          <p className="font-medium">{t('refused')}</p>
          <ul className="mt-1 list-disc pl-4">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${String(index)}`}>{issueText(issue)}</li>
            ))}
          </ul>
        </div>
      )}
      {failed && (
        <p role="alert" className="text-xs text-[color:var(--danger)]">
          {t('failed')}
        </p>
      )}
    </section>
  );
}
