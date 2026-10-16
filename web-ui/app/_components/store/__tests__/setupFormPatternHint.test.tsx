import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { FieldRow } from '../setupForm';
import type { InstallSetupField } from '../../../_lib/storeTypes';

/**
 * OM-17 follow-up — the INSTALL WIZARD half of "the server can only ever send
 * an English pattern_hint".
 *
 * `installService` rejects a mismatching value with
 * `{ key, code: 'pattern_mismatch', message }`, where `message` IS the
 * manifest's `pattern_hint` resolved to English: the middleware has no request
 * locale, so it cannot resolve anything else. A German operator installing a
 * plugin therefore read an English sentence in the one place that was supposed
 * to stop them typing their Google account password — and
 * "English field labels and help texts in a German UI" was itself a named
 * contributing factor of OM-17.
 *
 * `FieldRow` holds the whole `{ locale: text }` map (it renders it under the
 * input already), so it does the locale pick itself. No API change.
 */

const EN = 'expects a service account address, not a person';
const DE = 'erwartet eine Dienstkonto-Adresse, kein Personenkonto';

function field(over: Partial<InstallSetupField> = {}): InstallSetupField {
  return {
    key: 'gw_sa_client_email',
    label: { en: 'Service account email' },
    type: 'string',
    required: true,
    pattern_hint: { en: EN, de: DE },
    ...over,
  } as InstallSetupField;
}

describe('<FieldRow /> — a pattern rejection is shown in the ACTIVE locale', () => {
  it('renders the German hint as the error for a German operator', () => {
    renderWithIntl(
      <FieldRow
        field={field()}
        error={{ code: 'pattern_mismatch', message: EN }}
      />,
      { locale: 'de' },
    );

    // The error slot specifically — the static hint under the input also
    // carries this text, so asserting "somewhere in the DOM" would prove
    // nothing about the rejection.
    expect(screen.getByRole('alert').textContent).toBe(DE);
    // And the English sentence the server actually sent is nowhere on screen.
    expect(screen.queryByText(EN)).toBeNull();
  });

  it('renders the English hint as the error for an English operator', () => {
    renderWithIntl(
      <FieldRow
        field={field()}
        error={{ code: 'pattern_mismatch', message: EN }}
      />,
      { locale: 'en' },
    );

    expect(screen.getByRole('alert').textContent).toBe(EN);
  });

  it('falls back to the catalog sentence when the manifest declared no pattern_hint', () => {
    // #1401 — the generic sentence comes from the catalog in the active
    // locale, not from the server (which writes it in German only).
    renderWithIntl(
      <FieldRow
        field={field({ pattern_hint: undefined })}
        error={{ code: 'pattern_mismatch', message: '"x" entspricht nicht dem erwarteten Muster.' }}
      />,
      { locale: 'en' },
    );

    expect(screen.getByRole('alert').textContent).toBe(
      'Service account email does not match the expected format.',
    );
  });

  it('renders other known codes from the catalog too (#1401)', () => {
    // Was: rendered verbatim — so an English operator read the German
    // server sentence. See setupFormLocalizedErrors.test.tsx for the rest.
    renderWithIntl(
      <FieldRow
        field={field()}
        error={{ code: 'required', message: 'Feld "Service account email" ist erforderlich.' }}
      />,
      { locale: 'en' },
    );

    expect(screen.getByRole('alert').textContent).toBe('Service account email is required.');
  });

  it('renders no error slot at all when there is no error', () => {
    renderWithIntl(<FieldRow field={field()} />, { locale: 'de' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
