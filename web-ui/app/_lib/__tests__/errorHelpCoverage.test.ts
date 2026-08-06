import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERROR_HELP_CODES } from '../errorHelp';

/**
 * OM-09 — the catalogue must not silently fall behind the server.
 *
 * A code that reaches the browser with no `errorHelp.<code>` copy behind it
 * degrades to the generic "that failed" line, which is exactly the state this
 * issue was filed about. So the guard reads the route files themselves and
 * fails when one of them emits a code no locale explains.
 *
 * SCOPE IS EXPLICIT AND BOUNDED. Only the five files below are covered. The
 * repo emits ~238 codes in total; claiming to cover all of them while scanning
 * one emission shape would be a false guarantee, so the guard also asserts
 * that the covered files use ONLY that shape (see the last case).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const ROUTES_DIR = path.resolve(REPO_ROOT, 'middleware', 'src', 'routes');
const MESSAGES_DIR = path.resolve(HERE, '..', '..', '..', 'messages');

/** The route files whose codes this catalogue promises to cover. */
const COVERED_ROUTE_FILES = [
  'install.ts',
  'runtime.ts',
  'adminProviders.ts',
  'store.ts',
  'adminSettings.ts',
] as const;

/**
 * Codes that do NOT come from a route file, so a route scan can never find
 * them. `providers.key_rejected` is set by `rejected()` in
 * `middleware/src/platform/providerCredentialVerifier.ts` and reaches the UI
 * as `verifyErrorCode` on a 200 provider row, not as an error envelope.
 */
const NON_ROUTE_CODES = ['providers.key_rejected'] as const;

/**
 * How many codes the five files emitted when this guard was written. A path
 * typo, a renamed file or a broken regex would otherwise scan an empty set and
 * pass while covering nothing.
 */
const MIN_SCANNED_CODES = 45;

const CODE_LITERAL = /\bcode:\s*'([A-Za-z0-9_.]+)'/g;

type MessageNode = string | { [key: string]: MessageNode };

function readRouteFile(file: string): string {
  const full = path.join(ROUTES_DIR, file);
  // A missing file is a FAILURE, never a skip: the web-ui job runs from the
  // repo root, and a guard that skips itself is a guard that has been deleted.
  expect(
    fs.existsSync(full),
    `covered route file not found: ${full}. The guard resolves middleware/ ` +
      'relative to this test; fix the path rather than dropping the file.',
  ).toBe(true);
  return fs.readFileSync(full, 'utf8');
}

function scanCodes(): Set<string> {
  const out = new Set<string>(NON_ROUTE_CODES);
  for (const file of COVERED_ROUTE_FILES) {
    for (const m of readRouteFile(file).matchAll(CODE_LITERAL)) {
      const code = m[1];
      if (code !== undefined) out.add(code);
    }
  }
  return out;
}

/** Locales are DISCOVERED, never hardcoded — same rule as i18n-parity.test.ts. */
function loadLocales(): Map<string, Record<string, MessageNode>> {
  const out = new Map<string, Record<string, MessageNode>>();
  for (const entry of fs.readdirSync(MESSAGES_DIR).sort()) {
    if (!entry.endsWith('.json')) continue;
    out.set(
      entry.slice(0, -'.json'.length),
      JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, entry), 'utf8')) as Record<
        string,
        MessageNode
      >,
    );
  }
  return out;
}

/** Every `<family>.<name>` under a locale's `errorHelp` namespace. */
function catalogueCodes(messages: Record<string, MessageNode>): Set<string> {
  const namespace = messages['errorHelp'];
  const out = new Set<string>();
  if (typeof namespace !== 'object') return out;
  for (const [family, names] of Object.entries(namespace)) {
    if (typeof names !== 'object') continue;
    for (const name of Object.keys(names)) out.add(`${family}.${name}`);
  }
  return out;
}

function leaf(
  messages: Record<string, MessageNode>,
  code: string,
  field: 'what' | 'next',
): MessageNode | undefined {
  const [family, name] = code.split('.');
  const namespace = messages['errorHelp'];
  if (typeof namespace !== 'object' || family === undefined || name === undefined) {
    return undefined;
  }
  const familyNode = namespace[family];
  if (typeof familyNode !== 'object') return undefined;
  const codeNode = familyNode[name];
  if (typeof codeNode !== 'object') return undefined;
  return codeNode[field];
}

const SCANNED = scanCodes();
const LOCALES = loadLocales();

describe('errorHelp catalogue coverage', () => {
  it('scanned a non-empty set of codes from the covered route files', () => {
    expect(SCANNED.size).toBeGreaterThanOrEqual(MIN_SCANNED_CODES);
  });

  it('discovered at least one locale to check against', () => {
    expect(LOCALES.size).toBeGreaterThan(0);
  });

  it('has what + next copy for every emitted code, in every locale', () => {
    const missing: string[] = [];
    for (const [locale, messages] of LOCALES) {
      for (const code of [...SCANNED].sort()) {
        for (const field of ['what', 'next'] as const) {
          const value = leaf(messages, code, field);
          if (typeof value !== 'string' || value.trim().length === 0) {
            missing.push(`${locale}: errorHelp.${code}.${field}`);
          }
        }
      }
    }

    expect(
      missing,
      `Uncovered error codes. Add copy to web-ui/messages/*.json:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('has no orphan catalogue entries', () => {
    const orphans = [...catalogueCodes(LOCALES.get('en') ?? {})]
      .filter((code) => !SCANNED.has(code))
      .sort();

    expect(
      orphans,
      'errorHelp entries with no emitter in the covered files. Remove them, ' +
        'or add the code to NON_ROUTE_CODES with a comment naming its origin.',
    ).toEqual([]);
  });

  it('keeps ERROR_HELP_CODES in step with the copy', () => {
    expect([...ERROR_HELP_CODES].sort()).toEqual([...SCANNED].sort());
  });

  it('covered files use only the code: literal shape the scan can see', () => {
    // Two other emission shapes exist in this repo and a `code:` scan is blind
    // to both: positional `sendError(res, err, 'code')`
    // (routes/builder.ts:164, routes/builderPreview.ts:919,
    // routes/devPlatformGates.ts:51) and the `error: '…'` envelope key
    // (routes/builderPreview.ts). Introducing either into a covered file must
    // fail here and force the extractor to be extended, not let the guard
    // under-report in silence.
    const offenders: string[] = [];
    for (const file of COVERED_ROUTE_FILES) {
      const source = readRouteFile(file);
      if (/\bsendError\(/.test(source)) offenders.push(`${file}: sendError(`);
      if (/\berror:\s*'[a-z0-9_.]+'/.test(source)) offenders.push(`${file}: error: '…'`);
    }

    expect(
      offenders,
      'A covered route file grew an error shape this guard cannot scan. ' +
        'Extend the extractor in errorHelpCoverage.test.ts before merging.',
    ).toEqual([]);
  });
});
