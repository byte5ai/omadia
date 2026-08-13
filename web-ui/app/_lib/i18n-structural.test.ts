/**
 * Issue #679 — guards for the structural i18n categories left by #601.
 *
 * These are not translation tests; the catalogue gates
 * (`scripts/i18n-validate.mjs`, `i18n-parity.test.ts`) already cover wording.
 * What was missing is a check that the STRUCTURAL fixes stay fixed: nothing
 * about a static `metadata` export or a `toLocaleString` call fails a build, so
 * both categories grew silently for months and were only found by a manual
 * sweep. A category nobody measures is a category that comes back.
 *
 * Scope note: I4 is pinned repo-wide because it reached zero. I6 is pinned per
 * file, because the sweep is not finished — see the follow-up filed from #679.
 */

import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isSeededAgentDescription } from './agents';

const APP_DIR = path.resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(path.join(APP_DIR, rel), 'utf8');
}

describe('#679 / I4 — page titles follow the active locale', () => {
  it('no page still exports a static metadata object', () => {
    // `export const metadata` is evaluated once at build time, with no request
    // and therefore no locale, so every window title was English regardless of
    // the UI language. `generateMetadata` runs per request and can await
    // `getTranslations`.
    const offenders = globSync('**/page.tsx', { cwd: APP_DIR })
      .filter((f) => read(f).includes('export const metadata'))
      .sort();

    expect(offenders).toEqual([]);
  });

  it('every page defines generateMetadata or inherits the layout title', () => {
    // Guards the other direction: a page could satisfy the check above by
    // simply deleting its title. Any page that names `Metadata` must produce
    // one through the async form.
    const broken = globSync('**/page.tsx', { cwd: APP_DIR })
      .filter((f) => {
        const src = read(f);
        return (
          src.includes("from 'next'") &&
          src.includes('Metadata') &&
          !src.includes('generateMetadata')
        );
      })
      .sort();

    expect(broken).toEqual([]);
  });
});

describe('#679 / I6 — number and date formatting follows the active locale', () => {
  // `toLocaleString()` with no argument follows the BROWSER locale, and with a
  // pinned tag it follows that tag — neither is the locale the user chose in
  // the app. next-intl's `useFormatter()` is the only one that is.
  const SWEPT = ['admin/usage/page.tsx', 'admin/kg-lifecycle/page.tsx'];

  for (const file of SWEPT) {
    it(`${file} has no toLocaleString call`, () => {
      const code = read(file)
        .split('\n')
        // Comments explaining WHY the call was removed must not count as the
        // call coming back — the same false positive the repo's error-code
        // coverage check hit in #603.
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');

      expect(code).not.toContain('toLocaleString');
    });
  }

  it('no locale tag is hardcoded in the swept files', () => {
    for (const file of SWEPT) {
      expect(read(file)).not.toContain("'de-DE'");
      expect(read(file)).not.toContain("'en-US'");
    }
  });
});

describe('#679 / I5 — the boot-seeded agent description is recognised', () => {
  it('matches the exact sentence the middleware seeds', () => {
    // Structural contract with
    // `packages/harness-orchestrator/src/registry/onboarding.ts`. If the
    // middleware ever rewords its seed, this test is what says so — otherwise
    // the UI would quietly fall back to rendering the English sentence again,
    // which is the bug #679 filed.
    expect(
      isSeededAgentDescription(
        'Auto-seeded on first boot. Receives unbound channel traffic until the operator configures explicit bindings.',
      ),
    ).toBe(true);
  });

  it('leaves operator-edited descriptions alone', () => {
    // The moment an operator types their own words, those words are shown
    // verbatim — in whatever language they chose. A fuzzy match here would
    // overwrite operator content that merely resembled the seed.
    expect(isSeededAgentDescription('Auto-seeded on first boot.')).toBe(false);
    expect(
      isSeededAgentDescription(
        'Unser Standard-Orchestrator für alles ohne eigene Zuordnung.',
      ),
    ).toBe(false);
    expect(isSeededAgentDescription('')).toBe(false);
    expect(isSeededAgentDescription(null)).toBe(false);
    expect(isSeededAgentDescription(undefined)).toBe(false);
  });
});

describe('#679 / I3 — swept components carry no user-facing literals', () => {
  it('ListView renders no German literal', () => {
    // This component held three German sentences — the rule in
    // `web-ui/CLAUDE.md` broken twice over: hardcoded, and hardcoded in the
    // language that is supposed to exist only in `messages/de.json`.
    const src = read('graph/_components/ListView.tsx');

    expect(src).not.toContain('keine Entities in diesem Turn');
    expect(src).not.toContain('lade Run…');
    expect(src).not.toContain('keine Run-Trace erfasst');
    expect(src).toContain("useTranslations('graph.listView')");
  });
});
