'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import type { PersonaAxisKey } from '../../_lib/personaTypes';

/** The words for one persona axis: its name and its two slider ends. */
export interface PersonaAxisCopy {
  readonly name: string;
  readonly left: string;
  readonly right: string;
}

/**
 * #1887 — axis names and slider end labels from the catalogue
 * (`builder.persona.axes.<axis>.{name,left,right}`). They used to be English
 * literals in `personaTypes.ts` and raw axis keys on the radar.
 */
export function usePersonaAxisCopy(): (axis: PersonaAxisKey) => PersonaAxisCopy {
  const t = useTranslations('builder.persona.axes');
  return useCallback(
    (axis: PersonaAxisKey): PersonaAxisCopy => ({
      name: t(`${axis}.name`),
      left: t(`${axis}.left`),
      right: t(`${axis}.right`),
    }),
    [t],
  );
}
