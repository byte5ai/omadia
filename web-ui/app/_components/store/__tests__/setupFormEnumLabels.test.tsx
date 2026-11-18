import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { enumOptionLabel } from '../../../_lib/localized';
import { renderWithIntl } from '../../../_lib/test-utils';
import { FieldRow } from '../setupForm';
import type { InstallSetupField } from '../../../_lib/storeTypes';

/**
 * #1401 — enum option labels follow the UI language. The server keeps
 * `label` as English for older clients and adds `label_localized` when the
 * manifest wrote a map.
 */

const FIELD = {
  key: 'default_sycophancy',
  label: { en: 'Default sycophancy level', de: 'Default Sycophancy-Level' },
  type: 'enum',
  required: true,
  enum: [
    { value: 'off', label: 'Off — no rules', label_localized: { en: 'Off — no rules', de: 'Aus — keine Regeln' } },
    { value: 'low', label: 'Low' },
  ],
} as unknown as InstallSetupField;

describe('enum option labels', () => {
  it('render in German for a German operator', () => {
    renderWithIntl(<FieldRow field={FIELD} />, { locale: 'de' });
    expect(screen.getByRole('option', { name: 'Aus — keine Regeln' })).toBeTruthy();
    // An option without a map keeps its server label.
    expect(screen.getByRole('option', { name: 'Low' })).toBeTruthy();
  });

  it('render in English for an English operator', () => {
    renderWithIntl(<FieldRow field={FIELD} />, { locale: 'en' });
    expect(screen.getByRole('option', { name: 'Off — no rules' })).toBeTruthy();
  });

  it('enumOptionLabel falls back to label without a map (older server)', () => {
    expect(enumOptionLabel({ label: 'Raw' }, 'de')).toBe('Raw');
  });
});
