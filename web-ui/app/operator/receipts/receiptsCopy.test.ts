import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * #1081 — copy guard for the receipts page.
 *
 * A privacy receipt is only written for turns in which the privacy shield
 * acted: `finalizeTurn()` in harness-plugin-privacy-guard `service.ts`
 * returns no receipt unless the turn interned a dataset, recorded a bypass,
 * produced structured output, or masked the prompt, and the orchestrator
 * persists a row only when a receipt exists. The subtitle used to promise a
 * receipt for "every completed turn", which contradicted both the code and
 * the empty state right below it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.resolve(HERE, '..', '..', '..', 'messages');

/** Per-locale phrasings of the false "every turn writes a receipt" claim. */
const EVERY_TURN_CLAIMS: readonly RegExp[] = [
  /\b(every|each)\s+(completed\s+)?turn\s+(writes|persists)\b/i,
  /jeder\s+abgeschlossene\s+turn/i,
  // Genitive form ("der Receipt jedes abgeschlossenen Turns"), unless it is
  // immediately narrowed by a relative clause ("…, in dem der Shield …").
  /jedes\s+abgeschlossenen\s+turns\b(?!,\s*in\s+dem)/i,
];

/**
 * Per-locale wording the page must carry: the subtitle names the condition
 * (shield activity) and the empty state says that turns without it write no
 * receipt. Both went unguarded before — a revert to the old copy has to fail.
 */
const REQUIRED_COPY: Readonly<Record<string, { subtitle: RegExp; empty: RegExp }>> = {
  en: {
    subtitle: /every completed turn in which the privacy shield acted/i,
    empty: /write no receipt/i,
  },
  de: {
    subtitle: /jeden abgeschlossenen Turn, in dem der Privacy Shield aktiv war/i,
    empty: /schreiben keinen Receipt/i,
  },
};

interface ReceiptsCopy {
  readonly subtitle?: unknown;
  readonly empty?: unknown;
}

function loadLocales(): ReadonlyArray<{ locale: string; copy: ReceiptsCopy }> {
  return fs
    .readdirSync(MESSAGES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const raw = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, file), 'utf8')) as {
        operatorReceipts?: ReceiptsCopy;
      };
      return { locale: path.basename(file, '.json'), copy: raw.operatorReceipts ?? {} };
    });
}

describe('operatorReceipts copy (#1081)', () => {
  const locales = loadLocales();

  it('discovers at least the en and de catalogs', () => {
    const names = locales.map((l) => l.locale);
    expect(names).toEqual(expect.arrayContaining(['en', 'de']));
  });

  it.each(locales)('$locale subtitle does not promise a receipt for every turn', ({ copy }) => {
    expect(typeof copy.subtitle).toBe('string');
    for (const claim of EVERY_TURN_CLAIMS) {
      expect(copy.subtitle as string).not.toMatch(claim);
    }
  });

  it.each(locales)('$locale empty state is present', ({ copy }) => {
    expect(typeof copy.empty).toBe('string');
    expect((copy.empty as string).trim().length).toBeGreaterThan(0);
  });

  it.each(Object.entries(REQUIRED_COPY))(
    '%s copy states the shield-activity rule',
    (locale, required) => {
      const entry = locales.find((l) => l.locale === locale);
      expect(entry, `missing ${locale} catalog`).toBeDefined();
      expect(entry?.copy.subtitle as string).toMatch(required.subtitle);
      expect(entry?.copy.empty as string).toMatch(required.empty);
    },
  );
});
