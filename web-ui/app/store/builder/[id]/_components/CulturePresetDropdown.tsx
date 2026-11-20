'use client';

import { setPersonaConfig } from '../../../../_lib/api';
import type { PersonaConfig } from '../../../../_lib/personaTypes';
import { CulturePresetDropdown as SharedCulturePresetDropdown } from '@/app/_components/persona/CulturePresetDropdown';

/**
 * TEMPORARY (#2049) — the dropdown moved to `app/_components/persona/`. The
 * Plugin Builder's persona pillar still renders it with a draft id until that
 * pillar is removed; delete this adapter together with `PersonaPillar.tsx`.
 */
export function CulturePresetDropdown(props: {
  draftId: string;
  persona: PersonaConfig | undefined;
  disabled?: boolean;
  onApplied?: (next: PersonaConfig) => void;
}): React.ReactElement {
  return (
    <SharedCulturePresetDropdown
      persona={props.persona}
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      onApply={async (next) => {
        await setPersonaConfig(props.draftId, next);
        props.onApplied?.(next);
      }}
    />
  );
}
