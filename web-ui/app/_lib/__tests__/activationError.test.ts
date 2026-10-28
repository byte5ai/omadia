import { describe, expect, it } from 'vitest';

import de from '../../../messages/de.json';
import en from '../../../messages/en.json';
import {
  ACTIVATION_ERROR_CODES,
  activationErrorCopyKey,
  parseActivationErrorReason,
} from '../activationError';

/**
 * #1456 — the client half of the activation-failure classification.
 *
 * The middleware now sends a code; this narrows it at the boundary the same
 * tolerant way `parseTeamsIdentityLastErrorDetail` narrows its own error
 * detail. Tolerance is the point: a middleware older than the field sends
 * nothing and a newer one may send a code this build has no copy for, and in
 * both cases the operator must still get the localized fallback plus the raw
 * sentence — never a crash and never an empty panel.
 */

void describe('parseActivationErrorReason', () => {
  void it('narrows a known code with its arguments', () => {
    expect(
      parseActivationErrorReason({ code: 'secret_missing', field: 'odoo_api_key' }),
    ).toEqual({ code: 'secret_missing', field: 'odoo_api_key' });
  });

  void it('returns null when there is no reason at all', () => {
    expect(parseActivationErrorReason(null)).toBeNull();
    expect(parseActivationErrorReason(undefined)).toBeNull();
  });

  void it('falls back to unknown for a code this build has no copy for', () => {
    expect(parseActivationErrorReason({ code: 'invented_later' })).toEqual({
      code: 'unknown',
    });
  });

  void it('drops arguments of the wrong shape instead of rendering them', () => {
    expect(
      parseActivationErrorReason({ code: 'secret_missing', field: 42 }),
    ).toEqual({ code: 'secret_missing' });
    expect(
      parseActivationErrorReason({
        code: 'dependency_unresolved',
        requires: ['a@1', 7],
      }),
    ).toEqual({ code: 'dependency_unresolved' });
    expect(
      parseActivationErrorReason({
        code: 'dependency_unresolved',
        requires: ['a@1', 'b@2'],
      }),
    ).toEqual({ code: 'dependency_unresolved', requires: ['a@1', 'b@2'] });
  });

  void it('is total over junk', () => {
    expect(parseActivationErrorReason('secret_missing')).toBeNull();
    expect(parseActivationErrorReason(7)).toBeNull();
    expect(parseActivationErrorReason({})).toEqual({ code: 'unknown' });
  });
});

void describe('every code has operator copy in both locales', () => {
  for (const code of ACTIVATION_ERROR_CODES) {
    void it(`${code} has a what/next sentence in en and de`, () => {
      const key = activationErrorCopyKey(code);
      for (const [locale, messages] of [
        ['en', en],
        ['de', de],
      ] as const) {
        const copy = (
          messages.store.activationError as Record<
            string,
            { what?: string; next?: string; short?: string }
          >
        )[key];
        expect(copy, `${locale} is missing store.activationError.${key}`).toBeTruthy();
        expect(copy?.what?.length, `${locale} ${key}.what`).toBeGreaterThan(0);
        expect(copy?.next?.length, `${locale} ${key}.next`).toBeGreaterThan(0);
        expect(copy?.short?.length, `${locale} ${key}.short`).toBeGreaterThan(0);
      }
    });
  }

  void it('never instructs the operator to edit a manifest', () => {
    // The whole point of #1456: the raw message told the reader to add a line
    // to a manifest they do not have. The localized copy must not repeat it.
    for (const messages of [en, de]) {
      const serialized = JSON.stringify(messages.store.activationError);
      expect(serialized).not.toMatch(/manifest/i);
      expect(serialized).not.toMatch(/requires:/);
    }
  });
});
