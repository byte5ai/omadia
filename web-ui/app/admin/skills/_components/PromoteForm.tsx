'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { type AdminSkillDto, promoteSkill } from '../../../_lib/adminSkills';
import { ErrorLine, useErrorText } from '../../_components/AdminSurface';

/** Promote one published skill to a team (`group`) or the organisation. */
export function PromoteForm({
  skill,
  onPromoted,
}: {
  skill: AdminSkillDto;
  onPromoted: () => Promise<void>;
}): React.ReactElement {
  const t = useTranslations('adminSkills.promoteForm');
  const errorText = useErrorText({
    'skill_promotion.not_eligible': t('errors.notEligible'),
    'skill_promotion.not_found': t('errors.notFound'),
    'skill_promotion.transition_rejected': t('errors.rejected'),
    'skill_promotion.invalid_request': t('errors.invalid'),
  });
  const [kind, setKind] = useState<'group' | 'org'>('group');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const trimmed = ref.trim();

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await promoteSkill(
        skill.id,
        kind === 'group' ? { kind: 'group', groupRef: trimmed } : { kind: 'org', orgId: trimmed },
      );
      setRef('');
      await onPromoted();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed.length > 0) void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('kindLabel')}
          value={kind}
          onChange={(e) => setKind(e.target.value === 'org' ? 'org' : 'group')}
          className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm"
        >
          <option value="group">{t('kinds.group')}</option>
          <option value="org">{t('kinds.org')}</option>
        </select>
        <input
          aria-label={kind === 'group' ? t('groupRef') : t('orgId')}
          placeholder={kind === 'group' ? t('groupRef') : t('orgId')}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          className="w-36 rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-sm"
        />
        <Button type="submit" size="sm" disabled={trimmed.length === 0} busy={busy} busyLabel={t('working')}>
          {t('submit')}
        </Button>
      </div>
      {error !== null ? <ErrorLine text={errorText(error)} /> : null}
    </form>
  );
}
