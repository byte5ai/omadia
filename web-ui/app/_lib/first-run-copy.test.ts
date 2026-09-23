/**
 * Issue #1090 — the first-run path must not describe UI that no longer exists.
 *
 * Three copy defects shipped together because they share one cause: the S4
 * provider-v2 change removed the LLM-key field from the setup wizard and
 * renamed the provider admin page to "LLM-Zugang" / "LLM access", and the
 * copy sweep was never finished. Wording gates (`scripts/i18n-validate.mjs`,
 * `i18n-parity.test.ts`) cannot catch this class: every stale string is a
 * perfectly valid, perfectly translated sentence about a screen that is gone.
 *
 * These guards pin the claims, not the phrasing — they fail when copy starts
 * naming the removed wizard field or the old page name again.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

type MessageNode = string | { [key: string]: MessageNode };

const APP_DIR = path.resolve(__dirname, '..');
const MESSAGES_DIR = path.resolve(APP_DIR, '..', 'messages');

/** Locales are discovered, never hardcoded — same rule as `i18n-parity`. */
function loadLocales(): Array<[string, Map<string, string>]> {
  return fs
    .readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((entry) => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(MESSAGES_DIR, entry), 'utf8'),
      ) as Record<string, MessageNode>;
      return [entry.slice(0, -'.json'.length), flatten(raw)] as [
        string,
        Map<string, string>,
      ];
    });
}

function flatten(obj: Record<string, MessageNode>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(full, value);
    else for (const [k, v] of flatten(value, full)) out.set(k, v);
  }
  return out;
}

const LOCALES = loadLocales();

function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const [locale, messages] of LOCALES) {
    for (const [key, value] of messages) {
      if (pattern.test(value)) hits.push(`${locale}: ${key}`);
    }
  }
  return hits.sort();
}

describe('#1090 / defect 1 — copy names the nav entry that actually exists', () => {
  it('no string sends the operator to an "LLM providers" page', () => {
    // The nav renders `nav.llmAccess` ("LLM-Zugang" / "LLM access") for
    // /admin/providers, and the page heading is `adminLlm.title` — the same
    // words. "LLM-Provider" as a PAGE name exists nowhere the operator can
    // see it, so a hint naming it sends them scanning a menu for a label
    // that is not there. "LLM provider" as a THING (what you connect) is
    // fine and deliberately not matched here.
    expect(
      offenders(/Admin → LLM[- ]?[Pp]rovider|Seite LLM-Provider|LLM providers page/),
    ).toEqual([]);
  });

  it('every visible title for /admin/providers is the nav label', () => {
    // The dashboard health tile links to /admin/providers and titles itself,
    // so it is a second name for the same page on the very screen the
    // onboarding card sits on. It read "LLM-Provider" / "LLM provider" while
    // the nav said "LLM-Zugang" / "LLM access" — the same drift as the setup
    // hint, one screen earlier. Pinned to the nav label rather than to a
    // literal, so a future rename has to move both together.
    for (const [locale, messages] of LOCALES) {
      expect(`${locale}: ${messages.get('dashboard.health.llm.title') ?? '<missing>'}`).toBe(
        `${locale}: ${messages.get('nav.llmAccess') ?? '<missing>'}`,
      );
    }
  });

  it('adminProviders.title is gone rather than a second competing page name', () => {
    // It was never rendered (`ProvidersPanel` only reads `t('intro')`), and a
    // dead second name for a renamed page is exactly how this drift started.
    for (const [locale, messages] of LOCALES) {
      expect(`${locale}: ${String(messages.has('adminProviders.title'))}`).toBe(
        `${locale}: false`,
      );
    }
  });
});

describe('#1090 / defect 2 — no copy points at the removed wizard key step', () => {
  it('no secrets hint points at an unqualified "the wizard"', () => {
    // Two different wizards exist on the first-run path, and only one of them
    // still takes secrets: the per-plugin secrets wizard on a plugin's detail
    // page is current, the SETUP wizard stopped collecting a key in S4. A
    // secrets hint that just says "via the wizard" therefore reads, on the
    // very screen next to the setup wizard, as an instruction to a field that
    // is not there. Naming the detail page disambiguates it and is allowed;
    // naming the setup wizard never is.
    const mentions =
      /(?:Secrets|secrets|API[- ]?[Kk]eys?|Schlüssel)[^.]{0,60}(?:über den Wizard|via the wizard|im Wizard|in the wizard|Setup[- ]?Wizard|Setup-Assistent)/;
    const disambiguated = /Detail-Seite|detail page/;

    const hits: string[] = [];
    for (const [locale, messages] of LOCALES) {
      for (const [key, value] of messages) {
        if (!mentions.test(value)) continue;
        if (disambiguated.test(value) && !/Setup[- ]?Wizard|Setup-Assistent/.test(value)) {
          continue;
        }
        hits.push(`${locale}: ${key}`);
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  it('the setup namespace has no leftovers of the removed key field', () => {
    // Every `setup.*` key must be reachable from a component that reads the
    // namespace. The four `anthropicKey*` keys outlived their input by a whole
    // release, and one of them still pointed at "Admin → Runtime → Secrets",
    // a route this app does not have.
    //
    // Sourced from whichever files actually open the namespace, anywhere under
    // `app/` — not from a fixed directory. Pinning the scan to `app/setup/`
    // would report every `setup.*` key as an orphan the day the form moves
    // into a shared component, under a misleading "#1090" message.
    const readers = fs
      .readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(APP_DIR, f), 'utf8'))
      .filter((src) => /useTranslations\(\s*'setup(?:\.|')/.test(src));
    expect(readers.length).toBeGreaterThan(0);

    // `t('k')`, `t.rich('k')` and nested `t('a.b')` all count as a use;
    // `searchParams.get('x')` must not, which is what the lookbehind excludes.
    // A sub-namespace reader (`useTranslations('setup.errors')`) contributes
    // its own prefix, so its `t('keyRejected')` resolves to
    // `setup.errors.keyRejected` rather than looking like an orphan.
    const used = new Set<string>();
    for (const src of readers) {
      const prefixes = [...src.matchAll(/useTranslations\(\s*'setup(\.[^']*)?'/g)].map(
        (m) => (m[1] ?? '').replace(/^\./, ''),
      );
      for (const m of src.matchAll(/(?<![.\w])t(?:\.rich)?\('([A-Za-z0-9_.]+)'/g)) {
        const key = m[1];
        if (key === undefined) continue;
        for (const prefix of prefixes) {
          used.add(prefix ? `${prefix}.${key}` : key);
        }
      }
    }

    const [, en] = LOCALES.find(([l]) => l === 'en') ?? [];
    const declared = [...(en?.keys() ?? [])]
      .filter((k) => k.startsWith('setup.'))
      .map((k) => k.slice('setup.'.length));

    expect(declared.filter((k) => !used.has(k)).sort()).toEqual([]);
  });
});

describe('#1090 / defect 3 — completed onboarding steps are not "installed"', () => {
  it('the done-label is neutral, not an install claim', () => {
    // One label is rendered next to all three steps ("Connect an LLM",
    // "Choose a business case", "Install plugins"), so it cannot say
    // "Installed" — two of the three install nothing.
    for (const [locale, messages] of LOCALES) {
      const label = `${locale}: ${messages.get('dashboard.onboarding.done') ?? '<missing>'}`;
      expect(label).not.toMatch(/Installiert|Installed/);
      expect(label).not.toMatch(/<missing>/);
    }
  });

  it('the misleading `applied` key is gone, not merely re-worded', () => {
    // Renaming the value alone leaves the next contributor reading "applied"
    // and writing install wording back in.
    for (const [locale, messages] of LOCALES) {
      expect(
        `${locale}: ${String(messages.has('dashboard.onboarding.applied'))}`,
      ).toBe(`${locale}: false`);
    }
  });
});
