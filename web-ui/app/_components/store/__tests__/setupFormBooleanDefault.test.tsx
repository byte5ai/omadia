import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { FieldRow, extractValues } from '../setupForm';
import type { InstallSetupField } from '../../../_lib/storeTypes';

/**
 * #1464 — dev-platform 0.3.5 declares `webhooks_enabled` with
 * `default: "true"`. The box rendered unchecked, so an unchanged install
 * stored `false` and silently reversed the author's default.
 */

function field(def: unknown): InstallSetupField {
  return {
    key: 'webhooks_enabled',
    label: { en: 'Accept GitHub webhooks' },
    type: 'boolean',
    required: false,
    default: def,
  } as InstallSetupField;
}

describe('boolean setup field default', () => {
  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
    [undefined, false],
  ])('default %j pre-checks the box: %s', (def, checked) => {
    renderWithIntl(<FieldRow field={field(def)} />, { locale: 'en' });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(checked);
  });

  it('an unchanged install submits true for default "true"', () => {
    const { container } = renderWithIntl(
      <form>
        <FieldRow field={field('true')} />
      </form>,
      { locale: 'en' },
    );
    const form = container.querySelector('form')!;
    expect(extractValues([field('true')], new FormData(form))).toEqual({
      webhooks_enabled: true,
    });
  });
});
