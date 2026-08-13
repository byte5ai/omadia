import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { FieldRow } from '../setupForm';
import type { InstallSetupField } from '../../../_lib/storeTypes';

/**
 * #602 (OM-17) — setup-field `label` / `help` are localized maps. The tester's
 * report named "English field labels and help texts in a German UI" as a
 * contributing factor. `FieldRow` holds the whole `{ locale: text }` map and
 * picks the active locale itself (same mechanism as `pattern_hint`). These
 * assertions read the RENDERED output, not the field input.
 */

const LABEL = { en: 'Service account email', de: 'Dienstkonto-Adresse' };
const HELP = { en: 'From the Cloud console', de: 'Aus der Cloud-Konsole' };

function field(over: Partial<InstallSetupField> = {}): InstallSetupField {
  return {
    key: 'gw_sa_client_email',
    label: LABEL,
    help: HELP,
    type: 'string',
    required: true,
    ...over,
  };
}

describe('<FieldRow /> — label/help render in the active locale', () => {
  it('shows the German label and help for a German operator', () => {
    renderWithIntl(<FieldRow field={field()} />, { locale: 'de' });
    expect(screen.getByText(LABEL.de)).toBeTruthy();
    expect(screen.getByText(HELP.de)).toBeTruthy();
    expect(screen.queryByText(LABEL.en)).toBeNull();
    expect(screen.queryByText(HELP.en)).toBeNull();
  });

  it('shows the English label and help for an English operator', () => {
    renderWithIntl(<FieldRow field={field()} />, { locale: 'en' });
    expect(screen.getByText(LABEL.en)).toBeTruthy();
    expect(screen.getByText(HELP.en)).toBeTruthy();
  });

  it('falls back to another locale when the active one is absent', () => {
    // English-only map, German UI → German operator still sees the English
    // text (fallback) rather than a blank label.
    renderWithIntl(<FieldRow field={field({ label: { en: 'Only English' } })} />, {
      locale: 'de',
    });
    expect(screen.getByText('Only English')).toBeTruthy();
  });

  it('falls back to the field key when the label map is empty', () => {
    renderWithIntl(<FieldRow field={field({ label: {} })} />, { locale: 'de' });
    expect(screen.getByText('gw_sa_client_email')).toBeTruthy();
  });
});
