import { describe, expect, it } from 'vitest';

import de from '../../../messages/de.json';
import en from '../../../messages/en.json';

/**
 * #1474 — the installed plugin page had two sections both titled
 * "Permissions": the grants panel (own tables + public paths only) said the
 * plugin "asks for no special permissions" while the manifest section below
 * listed its memory reads and writes. The grants section has its own name now,
 * and its empty line names what it covers.
 */
describe('store detail — grants vs permissions (#1474)', () => {
  for (const [locale, messages] of [
    ['en', en],
    ['de', de],
  ] as const) {
    it(`${locale}: the two sections have different titles`, () => {
      expect(messages.store.detail.sectionGrants).not.toBe(
        messages.store.detail.sectionPermissions,
      );
    });

    it(`${locale}: the empty grants line points at the permissions section`, () => {
      expect(messages.store.grants.nothingDeclared).toContain(
        messages.store.detail.sectionPermissions,
      );
    });
  }
});
