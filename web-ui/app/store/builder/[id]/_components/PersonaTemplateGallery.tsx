'use client';

import { setPersonaConfig } from '../../../../_lib/api';
import type { PersonaConfig } from '../../../../_lib/personaTypes';
import { PersonaTemplateGallery as SharedPersonaTemplateGallery } from '@/app/_components/persona/PersonaTemplateGallery';

/**
 * TEMPORARY (#2049) — the gallery moved to `app/_components/persona/`. The
 * Plugin Builder's persona pillar still renders it with a draft id until that
 * pillar is removed; delete this adapter together with `PersonaPillar.tsx`.
 */
export function PersonaTemplateGallery(props: {
  draftId: string;
  persona: PersonaConfig | undefined;
  disabled?: boolean;
  onClose: () => void;
  onApplied?: (next: PersonaConfig) => void;
}): React.ReactElement {
  return (
    <SharedPersonaTemplateGallery
      persona={props.persona}
      onClose={props.onClose}
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      onApply={async (next) => {
        await setPersonaConfig(props.draftId, next);
        props.onApplied?.(next);
      }}
    />
  );
}
