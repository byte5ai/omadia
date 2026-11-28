'use client';

import { useTranslations } from 'next-intl';

import type { AdminSkillDto } from '../../../_lib/adminSkills';
import { CELL_CLASS, Mono, ROW_CLASS, TableFrame, THEAD_CLASS, useDateText, enumLabel } from '../../_components/AdminSurface';
import { PromoteForm } from './PromoteForm';

export function SkillTable({
  skills,
  onChanged,
}: {
  skills: readonly AdminSkillDto[];
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const t = useTranslations('adminSkills.list');
  const date = useDateText();
  return (
    <TableFrame>
      <thead className={THEAD_CLASS}>
        <tr>
          <th className={CELL_CLASS}>{t('name')}</th>
          <th className={CELL_CLASS}>{t('owner')}</th>
          <th className={CELL_CLASS}>{t('status')}</th>
          <th className={CELL_CLASS}>{t('capabilities')}</th>
          <th className={CELL_CLASS}>{t('signed')}</th>
          <th className={CELL_CLASS}>{t('promote')}</th>
        </tr>
      </thead>
      <tbody>
        {skills.map((skill) => (
          <tr key={skill.id} className={ROW_CLASS}>
            <td className={CELL_CLASS}>
              <div className="font-medium">{skill.name}</div>
              <Mono>{skill.slug}</Mono>
            </td>
            <td className={CELL_CLASS}>{skill.owner_scope ? <Mono>{skill.owner_scope}</Mono> : t('unowned')}</td>
            <td className={CELL_CLASS}>{enumLabel(t, 'statuses', skill.lifecycle_status)}</td>
            <td className={CELL_CLASS}>
              {skill.required_capabilities === null ? (
                <span className="text-[color:var(--danger)]">{t('capabilitiesInvalid')}</span>
              ) : skill.required_capabilities.length === 0 ? (
                t('capabilitiesNone')
              ) : (
                <Mono>{skill.required_capabilities.join(', ')}</Mono>
              )}
            </td>
            <td className={`${CELL_CLASS} whitespace-nowrap text-xs text-[color:var(--fg-muted)]`}>
              {date(skill.manifest_signed_at)}
            </td>
            <td className={CELL_CLASS}>
              {skill.promotable ? (
                <PromoteForm skill={skill} onPromoted={onChanged} />
              ) : (
                <span className="text-xs text-[color:var(--fg-muted)]">
                  {skill.owner_scope === null ? t('notPromotableUnowned') : t('notPromotableStatus')}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
