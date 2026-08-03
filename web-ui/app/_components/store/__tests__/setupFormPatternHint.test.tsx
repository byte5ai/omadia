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
    label: 'Service account email',
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

  it('keeps the server message when the manifest declared no pattern_hint', () => {
    // `installService` falls back to its own generic sentence in that case;
    // the client has nothing better and must not swallow it.
    const generic = '"Service account email" entspricht nicht dem erwarteten Muster.';
    renderWithIntl(
      <FieldRow
        field={field({ pattern_hint: undefined })}
        error={{ code: 'pattern_mismatch', message: generic }}
      />,
      { locale: 'de' },
    );

    expect(screen.getByRole('alert').textContent).toBe(generic);
  });

  it('leaves every OTHER error code untouched', () => {
    // Only the pattern code carries manifest-owned prose. A `required` or
    // `wrong_type` message must be rendered verbatim, hint or no hint.
    const required = 'Feld "Service account email" ist erforderlich.';
    renderWithIntl(
      <FieldRow field={field()} error={{ code: 'required', message: required }} />,
      { locale: 'de' },
    );

    expect(screen.getByRole('alert').textContent).toBe(required);
  });

  it('renders no error slot at all when there is no error', () => {
    renderWithIntl(<FieldRow field={field()} />, { locale: 'de' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
