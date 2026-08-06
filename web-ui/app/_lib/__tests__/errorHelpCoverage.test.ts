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
 * issue was filed about. So the guard reads the middleware sources themselves
 * and fails when one of them emits a code no locale explains.
 *
 * SCOPE IS EXPLICIT AND BOUNDED. Only the five route files below are covered;
 * the repo emits ~238 codes in total and a guard claiming all of them would be
 * a false guarantee.
 *
 * SCANNING `code: '…'` ALONE IS NOT ENOUGH, and the first version of this
 * guard was blind to the dominant emission shape of one of its own covered
 * files. `install.ts`'s `handleError` answers a thrown `InstallError` with
 * `{ code: err.code, message: err.message }` — the code is a variable, so ten
 * `install.*` codes reached the browser with no copy in any locale while this
 * test stayed green. The guard therefore does three things, and the last two
 * are what make the first one honest:
 *
 *   1. scan `code: '…'` literals in the covered files;
 *   2. FOLLOW registered forwarders (`FORWARDED_CODE_SOURCES`) into the file
 *      that actually holds the literals;
 *   3. fail on any `code:` in a covered file that is neither a literal nor a
 *      registered, explained non-literal (`ACKNOWLEDGED_NON_LITERAL_CODE`), so
 *      the next forwarding shape has to be followed rather than absorbed.
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
 * Covered files that re-emit a code held in a variable, plus the source file
 * whose throw sites hold the literals.
 *
 * `install.ts` is the only one today: `handleError` (install.ts:236-243) maps a
 * thrown `InstallError` onto `{ code: err.code }`, so none of the codes that
 * handler emits appear as a literal anywhere in the route file.
 */
const FORWARDED_CODE_SOURCES = [
  {
    /** The covered file doing the forwarding. */
    route: 'install.ts',
    /** The exact expression it forwards — also registered as acknowledged. */
    forwards: 'code: err.code',
    /** Where the literals live, relative to the repo root. */
    source: ['middleware', 'src', 'plugins', 'installService.ts'],
    /** `throw new InstallError('install.blocked', …)` */
    literal: /new InstallError\(\s*'([A-Za-z0-9_.]+)'/g,
    /** Throw sites present when this forwarder was registered. */
    minCodes: 11,
  },
] as const;

/**
 * Every `code:` in a covered file that is NOT a single-quoted literal, with the
 * reason it is not an unexplained error code. Anything outside this list fails:
 * a route file that starts forwarding a code from somewhere the extractor does
 * not read would otherwise ship codes with no copy while the suite stays green,
 * which is the exact defect this registry closes.
 */
const ACKNOWLEDGED_NON_LITERAL_CODE: Readonly<
  Record<string, readonly { readonly expr: string; readonly why: string }[]>
> = {
  'install.ts': [
    {
      expr: 'code: string;',
      why: "type annotation on handleError's response body",
    },
    {
      expr: "code: strParam(req.query['code'])",
      why: 'the OAuth authorization code off the provider callback, not an error code',
    },
    {
      expr: 'code: err.code',
      why: 'a thrown InstallError — followed via FORWARDED_CODE_SOURCES',
    },
  ],
  'runtime.ts': [
    {
      expr: 'code: string;',
      why: "type annotation on validateMultiselectValue's error result",
    },
  ],
};

/**
 * How many codes the covered files emitted when this guard last moved. A path
 * typo, a renamed file or a broken regex would otherwise scan an empty set and
 * pass while covering nothing.
 */
const MIN_SCANNED_CODES = 56;

const CODE_LITERAL = /\bcode:\s*'([A-Za-z0-9_.]+)'/g;
const ANY_CODE_KEY = /\bcode:/g;

type MessageNode = string | { [key: string]: MessageNode };

// A missing file is a FAILURE, never a skip: the web-ui job runs from the repo
// root, and a guard that skips itself is a guard that has been deleted.
function readRequired(full: string, hint: string): string {
  expect(fs.existsSync(full), hint).toBe(true);
  return fs.readFileSync(full, 'utf8');
}

function readRouteFile(file: string): string {
  const full = path.join(ROUTES_DIR, file);
  return readRequired(
    full,
    `covered route file not found: ${full}. The guard resolves middleware/ ` +
      'relative to this test; fix the path rather than dropping the file.',
  );
}

/** The literals behind each registered forwarder, keyed by the covered file. */
function scanForwarded(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const entry of FORWARDED_CODE_SOURCES) {
    const full = path.resolve(REPO_ROOT, ...entry.source);
    const source = readRequired(
      full,
      `forwarded-code source not found: ${full}. ${entry.route} re-emits ` +
        `\`${entry.forwards}\`, so the literals must stay readable from here.`,
    );
    const codes = new Set<string>();
    for (const m of source.matchAll(entry.literal)) {
      const code = m[1];
      if (code !== undefined) codes.add(code);
    }
    out.set(entry.route, codes);
  }
  return out;
}

function scanCodes(): Set<string> {
  const out = new Set<string>(NON_ROUTE_CODES);
  for (const file of COVERED_ROUTE_FILES) {
    for (const m of readRouteFile(file).matchAll(CODE_LITERAL)) {
      const code = m[1];
      if (code !== undefined) out.add(code);
    }
  }
  for (const codes of scanForwarded().values()) {
    for (const code of codes) out.add(code);
  }
  return out;
}

/** `<file>:<line>: <expr>` for every `code:` the extractor cannot account for. */
function unexplainedCodeExpressions(file: string, source: string): string[] {
  const acknowledged = ACKNOWLEDGED_NON_LITERAL_CODE[file] ?? [];
  const out: string[] = [];
  source.split('\n').forEach((line, index) => {
    for (const m of line.matchAll(ANY_CODE_KEY)) {
      const expr = line.slice(m.index ?? 0).trim();
      if (/^code:\s*'/.test(expr)) continue;
      if (acknowledged.some((entry) => expr.startsWith(entry.expr))) continue;
      out.push(`${file}:${index + 1}: ${expr}`);
    }
  });
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

  it('still reaches the literals behind every registered forwarder', () => {
    // A forwarder registration goes stale in two directions and both are bad:
    // the route file stops forwarding (and the followed codes become phantom
    // entries the orphan check then blames on the copy), or the source file
    // stops holding the literals (and the codes silently drop out of coverage).
    const forwarded = scanForwarded();
    for (const entry of FORWARDED_CODE_SOURCES) {
      const route = readRouteFile(entry.route);
      expect(
        route.includes(entry.forwards),
        `${entry.route} no longer contains \`${entry.forwards}\`. Drop the ` +
          'forwarder from FORWARDED_CODE_SOURCES, or point it at the new shape.',
      ).toBe(true);
      expect(
        forwarded.get(entry.route)?.size ?? 0,
        `${path.join(...entry.source)} yielded fewer codes than when the ` +
          `forwarder was registered. ${entry.route} emits every one of them, ` +
          'so a broken pattern here means uncovered codes reach the browser.',
      ).toBeGreaterThanOrEqual(entry.minCodes);
    }
  });

  it('accounts for every `code:` a covered file writes', () => {
    // This is the case that closes the blind spot. Anything that is not a
    // literal must be registered with a reason — a forwarded variable
    // (followed above), a type annotation, or a `code` that is not an error
    // code at all. An unregistered one fails here rather than shipping a code
    // with no copy behind it.
    const unexplained: string[] = [];
    for (const file of COVERED_ROUTE_FILES) {
      unexplained.push(...unexplainedCodeExpressions(file, readRouteFile(file)));
    }

    expect(
      unexplained,
      'A covered route file writes a `code:` the extractor cannot read. Make ' +
        'it a literal, register a forwarder in FORWARDED_CODE_SOURCES, or add ' +
        'it to ACKNOWLEDGED_NON_LITERAL_CODE with the reason it is not an ' +
        `error code:\n${unexplained.join('\n')}`,
    ).toEqual([]);
  });

  it('covered files use no error envelope the extractor cannot see', () => {
    // Two further emission shapes exist in this repo and neither scan above
    // can see them: positional `sendError(res, err, 'code')`
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
