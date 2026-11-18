import { readFileSync } from 'node:fs';
import path from 'node:path';

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { jobStepText } from '../InstallButton';
import { FieldRow, type SetupFieldError } from '../setupForm';
import type { InstallSetupField } from '../../../_lib/storeTypes';

import deMessages from '../../../../messages/de.json';
import enMessages from '../../../../messages/en.json';

/**
 * #1401 — install validation errors and job steps follow the UI language.
 *
 * The middleware has no request locale and writes these texts in German
 * (`installService.ts`), so the English UI showed "Feld … ist erforderlich."
 * and "Eingaben enthalten Fehler". The server now sends a stable `code` (plus
 * `params` where the setup schema cannot supply the value) and the client
 * renders it from its catalog. Unknown codes keep the server's text.
 */

function field(over: Partial<InstallSetupField> = {}): InstallSetupField {
  return {
    key: 'base_url',
    label: { en: 'Public base URL', de: 'Öffentliche Basis-URL' },
    type: 'url',
    required: true,
    ...over,
  } as InstallSetupField;
}

function errorText(
  error: SetupFieldError,
  locale: 'en' | 'de',
  over: Partial<InstallSetupField> = {},
): string | null {
  renderWithIntl(<FieldRow field={field(over)} error={error} />, { locale });
  return screen.getByRole('alert').textContent;
}

const ADMIN_V1 = path.resolve(__dirname, '../../../../../middleware/src/api/admin-v1.ts');

const GERMAN_SERVER_MESSAGE = 'Feld "Öffentliche Basis-URL" ist erforderlich.';

describe('<FieldRow /> — server validation errors in the active locale', () => {
  it('renders `required` in English for an English operator', () => {
    expect(errorText({ code: 'required', message: GERMAN_SERVER_MESSAGE }, 'en')).toBe(
      'Public base URL is required.',
    );
  });

  it('renders `required` in German with the German label', () => {
    expect(errorText({ code: 'required', message: GERMAN_SERVER_MESSAGE }, 'de')).toBe(
      '„Öffentliche Basis-URL“ ist erforderlich.',
    );
  });

  it('picks the wrong_type sentence by field type (integer)', () => {
    expect(errorText({ code: 'wrong_type', message: 'x' }, 'en', { type: 'integer' })).toBe(
      'Public base URL must be a whole number.',
    );
  });

  it('picks the wrong_type sentence by field type (boolean)', () => {
    expect(errorText({ code: 'wrong_type', message: 'x' }, 'en', { type: 'boolean' })).toBe(
      'Public base URL must be true or false.',
    );
  });

  it('lists the allowed values for enum_mismatch from the schema', () => {
    const text = errorText({ code: 'enum_mismatch', message: 'x' }, 'en', {
      type: 'enum',
      enum: [
        { value: 'off', label: 'Off' },
        { value: 'high', label: 'High' },
      ],
    } as Partial<InstallSetupField>);
    expect(text).toBe('Public base URL must be one of the allowed values: off, high.');
  });

  it('uses the host from params for invalid_host, and the server text without it', () => {
    expect(
      errorText(
        { code: 'invalid_host', message: 'x', params: { host: 'https://a.example' } },
        'en',
        { type: 'host_list' },
      ),
    ).toBe('“https://a.example” is not a valid host name (no protocol, no path).');
  });

  it('renders json_file missing_value from its params, in German', () => {
    expect(
      errorText(
        { code: 'missing_value', message: 'english', params: { path: '$.client_email', target: 'sa_email' } },
        'de',
        { type: 'json_file' },
      ),
    ).toBe(
      'Die hochgeladene Datei enthält bei $.client_email keinen verwendbaren Wert (benötigt für sa_email). Prüfe, ob du die richtige Datei gewählt hast.',
    );
  });

  it('picks the unexpected_document sentence by which params arrived', () => {
    expect(
      errorText(
        { code: 'unexpected_document', message: 'x', params: { key: 'type', expected: '"service_account"' } },
        'en',
        { type: 'json_file' },
      ),
    ).toBe('This does not look like the expected file: type is missing, expected "service_account".');
  });

  it('keeps the server message for json_file codes from an older server (no params)', () => {
    expect(errorText({ code: 'missing_value', message: 'old english' }, 'de', { type: 'json_file' })).toBe(
      'old english',
    );
  });

  it('keeps the server message for a code this build does not know', () => {
    expect(errorText({ code: 'missing_value', message: 'server text' }, 'en')).toBe(
      'server text',
    );
  });

  it('keeps the server message for invalid_host from an older server (no params)', () => {
    expect(
      errorText({ code: 'invalid_host', message: 'alter Text' }, 'en', { type: 'host_list' }),
    ).toBe('alter Text');
  });
});

describe('jobStepText', () => {
  const tFor =
    (messages: typeof enMessages) =>
    (key: string): string =>
      (messages.store.install.steps as Record<string, string>)[key] ?? `!${key}`;

  it('renders the step code in the active locale', () => {
    const job = { current_step: 'Eingaben enthalten Fehler', step_code: 'failed' };
    expect(jobStepText(job, tFor(enMessages))).toBe('Failed');
    expect(jobStepText(job, tFor(deMessages))).toBe('Fehlgeschlagen');
  });

  it('falls back to current_step for an older server or an unknown code', () => {
    expect(jobStepText({ current_step: 'Warte auf Konfiguration' }, tFor(enMessages))).toBe(
      'Warte auf Konfiguration',
    );
    expect(
      jobStepText({ current_step: 'neu', step_code: 'brand_new_step' }, tFor(enMessages)),
    ).toBe('neu');
  });

  it('renders every InstallJobStep the server declares, in both locales', () => {
    // Read from the middleware type itself, so a new step there without a
    // catalog entry (or a KNOWN_STEP_CODES entry) fails here.
    const source = readFileSync(ADMIN_V1, 'utf-8');
    const union = /export type InstallJobStep =([^;]+);/.exec(source)?.[1] ?? '';
    const codes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThanOrEqual(8);
    for (const messages of [enMessages, deMessages]) {
      for (const code of codes) {
        const text = jobStepText({ current_step: 'SERVER', step_code: code }, tFor(messages));
        expect(text, code).not.toBe('SERVER');
        expect(text, code).not.toMatch(/^!/);
      }
    }
  });
});
