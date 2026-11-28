'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { type AdminSkillDto, listAdminSkills } from '../../_lib/adminSkills';
import { ErrorLine, MutedLine, SurfaceFrame, SurfaceSection, useErrorText } from '../_components/AdminSurface';
import { SkillTable } from './_components/SkillTable';

/**
 * Admin → Skills (#2320, ADR-0068). Every skill with its home scope and
 * lifecycle status; a published, owned skill can be promoted to a team or the
 * organisation, which re-signs its manifest.
 */

type Load = { kind: 'loading' } | { kind: 'ready'; skills: AdminSkillDto[] } | { kind: 'error'; error: unknown };

export default function AdminSkillsPage(): React.ReactElement {
  const t = useTranslations('adminSkills');
  const errorText = useErrorText();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const skills = await listAdminSkills();
        if (!cancelled) setState({ kind: 'ready', skills });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generation]);

  return (
    <SurfaceFrame title={t('title')} intro={t('intro')}>
      <SurfaceSection heading={t('list.heading')} hint={t('list.hint')}>
        {state.kind === 'loading' ? (
          <MutedLine text={t('loading')} />
        ) : state.kind === 'error' ? (
          <ErrorLine text={errorText(state.error)} />
        ) : state.skills.length === 0 ? (
          <MutedLine text={t('list.empty')} />
        ) : (
          <SkillTable skills={state.skills} onChanged={async () => setGeneration((g) => g + 1)} />
        )}
      </SurfaceSection>
    </SurfaceFrame>
  );
}
