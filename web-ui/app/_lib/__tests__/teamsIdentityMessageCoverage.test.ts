import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TEAMS_IDENTITY_LAST_ERROR_CODES } from '../agents';

/**
 * The Teams provisioning error panel renders KEYS, not strings.
 *
 * `teamsIdentityErrorMessages` builds `errors.<code>.what` and
 * `errors.<code>.next` for every code without exception, so a catalogue entry
 * written as a FLAT string satisfies every existing gate and still renders the
 * raw key path at the operator. That is precisely what happened to
 * `rsc_permissions_mismatch`: the copy was written, reviewed and translated
 * into both locales as one sentence, the parity gate compared it against its
 * equally-flat twin and passed, and the panel showed
 * `operatorAgents.teamsIdentity.errors.rsc_permissions_mismatch.what` in
 * production.
 *
 * Neither of the two existing catalogue gates could catch it. `i18n:check`
 * asks whether de and en agree with each other; `errorHelpCoverage` asks
 * whether a middleware code has copy at all. This one asks the question the
 * renderer actually asks — does the SHAPE the component reads exist — and it
 * is driven by the same exported code list the component's builder is, so a
 * new code cannot be added without its two lines.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.resolve(HERE, '..', '..', '..', 'messages');
const LOCALES = ['de', 'en'] as const;

type Catalogue = Record<string, unknown>;

function load(locale: string): Catalogue {
  const raw = fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf8');
  return JSON.parse(raw) as Catalogue;
}

/** The `errors` namespace the panel resolves its keys against. */
function errorsOf(locale: string): Record<string, unknown> {
  const root = load(locale);
  const operatorAgents = root['operatorAgents'] as Record<string, unknown>;
  const teamsIdentity = operatorAgents['teamsIdentity'] as Record<
    string,
    unknown
  >;
  return teamsIdentity['errors'] as Record<string, unknown>;
}

describe('teams identity error catalogue', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] every last-error code has .what and .next`, () => {
      const errors = errorsOf(locale);
      const missing: string[] = [];
      for (const code of TEAMS_IDENTITY_LAST_ERROR_CODES) {
        const entry = errors[code];
        // A string here is the exact failure mode this guard exists for: the
        // copy is present, the parity gate is happy, and the panel renders the
        // key path because it asked for `.what` of a string.
        if (typeof entry !== 'object' || entry === null) {
          missing.push(`${code} (not an object)`);
          continue;
        }
        const shape = entry as Record<string, unknown>;
        if (typeof shape['what'] !== 'string') missing.push(`${code}.what`);
        if (typeof shape['next'] !== 'string') missing.push(`${code}.next`);
      }
      expect(missing).toEqual([]);
    });
  }

  it('both locales describe the same set of codes', () => {
    // The parity gate already compares the catalogues wholesale; this narrows
    // the same claim to the one namespace this file is about, so a failure
    // points at the panel instead of at a 4000-key diff.
    expect(Object.keys(errorsOf('de')).sort()).toEqual(
      Object.keys(errorsOf('en')).sort(),
    );
  });
});
