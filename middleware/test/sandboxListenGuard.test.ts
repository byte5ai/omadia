import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { isSandboxListenDenied, loopbackRequired } from './_helpers/listenLoopback.js';

/**
 * #1024 — one guard, seven call sites, and a grep so an eighth cannot appear.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Seven places had grown their own version of "the sandbox refused a loopback
 * listener, so skip". Three were named `isSandboxListenDenied`, two
 * `isSandboxListenError`, two were written inline — and they did not agree.
 * #1017 taught only the `cliBridge` copy to respect `OMADIA_EXPECT_LOOPBACK`,
 * so on a runner where `bind(127.0.0.1:0)` returns `EPERM`
 * `publicMcpPrivacy.e2e`, `publicMcpMaskingAssertion` and
 * `devEndpointsAuth.e2e` still deleted themselves and reported success. A
 * privacy-masking assertion and an auth e2e are the last two suites that
 * should be able to do that.
 *
 * WHY A GREP GUARD AND NOT JUST THE UNIT TEST
 * -------------------------------------------
 * The unit test below pins the helper's behaviour. It cannot notice a NEW
 * eighth copy appearing beside it — which is exactly how this spread in the
 * first place: each author reasonably wrote three lines rather than hunting
 * for a shared one. Two "guards" in this repo have already turned out to prove
 * nothing (a deny-list drift check that built its candidates from the list it
 * was checking, and a service-grant scanner that skipped the very verb the
 * code used), so this file states its own blind spot and covers it.
 */

/**
 * Every source file under `middleware/test`, so a new copy anywhere is in
 * scope.
 *
 * #1029 — this used to collect `.ts` and `.mts` only. A rogue guard in a
 * `.js` test helper, a `.cts` fixture or a `.tsx` file was invisible to
 * both scans below, which is the same "the guard has an exclusion list and
 * the exclusion list is where it goes blind" failure the doc comment warns
 * about. Extensions are enumerated rather than "anything not a directory"
 * because the tree also holds `.json`, `.sql` and binary fixtures whose
 * contents would produce noise, not signal.
 */
const SCANNED_EXTENSIONS = [
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
];

function testTreeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      testTreeFiles(full, out);
      continue;
    }
    if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * #1029 — `new URL('.', import.meta.url).pathname` leaves percent-encoding
 * in place, so a checkout path containing a space or any character needing
 * escaping yields a directory that does not exist. `readdirSync` would then
 * throw, or worse the scan would walk nothing and report zero offenders:
 * a guard that fails OPEN. `fileURLToPath` decodes properly.
 */
const TEST_ROOT = fileURLToPath(new URL('.', import.meta.url));
const HELPER = join(TEST_ROOT, '_helpers', 'listenLoopback.ts');

/**
 * Files the scans below cannot include, and why — stated rather than quietly
 * filtered, because a guard's exclusion list is where a guard goes blind.
 *
 *   - the helper: it is the one place that MAY define the predicate.
 *   - this file: it necessarily contains the very literals it searches for,
 *     namely the regex source on the next few lines and the doc comment that
 *     explains it. Nothing else here can hide a rogue guard, since a copy
 *     defined inside its own detector would still fail the `defined in exactly
 *     one place` assertion above.
 */
const SCAN_EXEMPT = new Set([HELPER, join(TEST_ROOT, 'sandboxListenGuard.test.ts')]);

describe('sandbox loopback guard (#1024)', () => {
  const eperm = (): Error => Object.assign(new Error('listen EPERM'), { code: 'EPERM' });

  it('skips on EPERM when the environment tolerates a denied listener', () => {
    const saved = { flag: process.env.OMADIA_EXPECT_LOOPBACK, ci: process.env.CI };
    delete process.env.OMADIA_EXPECT_LOOPBACK;
    delete process.env.CI;
    try {
      assert.equal(loopbackRequired(), false);
      assert.equal(isSandboxListenDenied(eperm()), true);
    } finally {
      if (saved.flag !== undefined) process.env.OMADIA_EXPECT_LOOPBACK = saved.flag;
      if (saved.ci !== undefined) process.env.CI = saved.ci;
    }
  });

  /**
   * The load-bearing case. Before #1017/#1024 this returned `true` at six of
   * the seven sites, which turned a bind failure into a green suite.
   */
  it('refuses to skip on EPERM when OMADIA_EXPECT_LOOPBACK is set', () => {
    const saved = { flag: process.env.OMADIA_EXPECT_LOOPBACK, ci: process.env.CI };
    process.env.OMADIA_EXPECT_LOOPBACK = '1';
    delete process.env.CI;
    try {
      assert.equal(loopbackRequired(), true);
      assert.equal(isSandboxListenDenied(eperm()), false);
    } finally {
      delete process.env.OMADIA_EXPECT_LOOPBACK;
      if (saved.flag !== undefined) process.env.OMADIA_EXPECT_LOOPBACK = saved.flag;
      if (saved.ci !== undefined) process.env.CI = saved.ci;
    }
  });

  /** `CI` is the signal the two `test/auth/**` suites already used. */
  it('refuses to skip on EPERM when CI is set', () => {
    const saved = { flag: process.env.OMADIA_EXPECT_LOOPBACK, ci: process.env.CI };
    delete process.env.OMADIA_EXPECT_LOOPBACK;
    process.env.CI = 'true';
    try {
      assert.equal(loopbackRequired(), true);
      assert.equal(isSandboxListenDenied(eperm()), false);
    } finally {
      delete process.env.CI;
      if (saved.flag !== undefined) process.env.OMADIA_EXPECT_LOOPBACK = saved.flag;
      if (saved.ci !== undefined) process.env.CI = saved.ci;
    }
  });

  it('never swallows an error that is not a denied listener', () => {
    const saved = { flag: process.env.OMADIA_EXPECT_LOOPBACK, ci: process.env.CI };
    delete process.env.OMADIA_EXPECT_LOOPBACK;
    delete process.env.CI;
    try {
      const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      assert.equal(isSandboxListenDenied(inUse), false);
      assert.equal(isSandboxListenDenied(new Error('plain')), false);
      assert.equal(isSandboxListenDenied('EPERM'), false);
      assert.equal(isSandboxListenDenied(undefined), false);
    } finally {
      if (saved.flag !== undefined) process.env.OMADIA_EXPECT_LOOPBACK = saved.flag;
      if (saved.ci !== undefined) process.env.CI = saved.ci;
    }
  });

  /**
   * The anti-regrowth half: only the shared helper may DEFINE this predicate.
   * Importing and calling it is what every other file should do.
   */
  it('is defined in exactly one place under middleware/test', () => {
    const definition = /(?:function|const)\s+isSandboxListen[A-Za-z]*\s*[(:=]/;
    const offenders = testTreeFiles(TEST_ROOT)
      .filter((file) => !SCAN_EXEMPT.has(file))
      .filter((file) => definition.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(TEST_ROOT.length));

    assert.deepEqual(
      offenders,
      [],
      `These files define their own sandbox-listen guard instead of importing ` +
        `the shared one from test/_helpers/listenLoopback.ts: ${offenders.join(', ')}. ` +
        `A local copy will not honour OMADIA_EXPECT_LOOPBACK, so the suite ` +
        `silently deletes itself on a listener-denied runner (#1024).`,
    );
  });

  /** A bare inline `code === 'EPERM'` is the same bug without a function name. */
  /**
   * #1029 — the previous pattern was `/code\s*===\s*'EPERM'/`, which is
   * literal-and-quote shaped. All of these slipped past it, each a plausible
   * thing to type:
   *
   *   code === "EPERM"        double quotes
   *   code == 'EPERM'         loose equality
   *   'EPERM' === code        comparison written the other way round
   *   ['EPERM'].includes(c)   array membership
   *   c.includes('EPERM')     substring test
   *   errno === -1            the numeric form of the same errno
   *   os.constants.errno.EPERM  the named constant
   *
   * Detection is now behaviour-shaped rather than name-shaped, which also
   * subsumes the sibling scan above: a rogue guard may be called anything,
   * but it cannot avoid naming the condition it tests.
   */
  const ROGUE_CHECKS: ReadonlyArray<readonly [RegExp, string]> = [
    [/===?\s*['"`]EPERM['"`]/, "compares something to 'EPERM'"],
    [/['"`]EPERM['"`]\s*===?/, "compares 'EPERM' to something"],
    [/\.includes\(\s*['"`]EPERM['"`]/, "tests membership of 'EPERM'"],
    [/\[\s*['"`]EPERM['"`]\s*\]/, "indexes or lists 'EPERM'"],
    [/errno\s*===?\s*-\s*1\b/, 'compares errno to -1 (the numeric EPERM)'],
    [/constants\s*\.\s*errno\s*\.\s*EPERM/, 'reads os.constants.errno.EPERM'],
  ];

  it('has no inline listener check outside the shared helper, in any spelling', () => {
    const offenders: string[] = [];
    for (const file of testTreeFiles(TEST_ROOT)) {
      if (SCAN_EXEMPT.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const [pattern, why] of ROGUE_CHECKS) {
        if (pattern.test(source)) {
          offenders.push(`${file.slice(TEST_ROOT.length)} (${why})`);
          break;
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `These files decide for themselves whether a refused listener is ` +
        `tolerable, instead of calling isSandboxListenDenied / ` +
        `loopbackRequired: ${offenders.join(', ')}. Such a check cannot ` +
        `honour OMADIA_EXPECT_LOOPBACK, so the suite self-skips on a runner ` +
        `where the listener is genuinely broken (#1024).`,
    );
  });

  /**
   * What this guard still cannot see, stated rather than implied — a
   * guard's blind spot belongs in the file, not in a reviewer's head.
   *
   *   - a literal assembled at runtime (`'EP' + 'ERM'`, `fromCharCode`);
   *   - the code imported from a constant in a non-test file;
   *   - a check that swallows EVERY listen error rather than naming EPERM
   *     (`catch { return; }` around a bind) — shape-invisible, and the
   *     reason the positive assertions above exist alongside the scans;
   *   - source outside `middleware/test`.
   *
   * The first two are deliberate evasion rather than the accident this
   * guard exists to catch; the third is why `loopbackRequired()` is
   * exported for callers that want their own diagnostic.
   */
  it('proves the widened scan actually matches every spelling it claims', () => {
    // A guard that lists patterns but never proves they fire is the exact
    // class of decorative check this file was written to replace.
    const rogueSpellings = [
      "if (err.code === \"EPERM\") return;",
      "if (err.code == 'EPERM') return;",
      "if ('EPERM' === err.code) return;",
      "if (['EPERM'].includes(err.code)) return;",
      "if (String(err.code).includes('EPERM')) return;",
      'if (err.errno === -1) return;',
      'if (err.errno === constants.errno.EPERM) return;',
    ];

    for (const snippet of rogueSpellings) {
      const matched = ROGUE_CHECKS.some(([pattern]) => pattern.test(snippet));
      assert.ok(matched, `no ROGUE_CHECKS pattern matches: ${snippet}`);
    }

    // And it must not fire on the correct usage, or every honest caller
    // becomes an offender and the guard gets deleted for crying wolf.
    const legitimate = [
      "import { isSandboxListenDenied } from './_helpers/listenLoopback.js';",
      'if (isSandboxListenDenied(error)) return;',
      'if (loopbackRequired()) throw error;',
    ];
    for (const snippet of legitimate) {
      const matched = ROGUE_CHECKS.some(([pattern]) => pattern.test(snippet));
      assert.equal(matched, false, `false positive on: ${snippet}`);
    }
  });

  /** The flag has to stay discoverable, or the next author writes a local copy. */
  it('documents the flag in .env.example', () => {
    const env = readFileSync(join(TEST_ROOT, '..', '.env.example'), 'utf8');
    assert.ok(
      env.includes('OMADIA_EXPECT_LOOPBACK'),
      '.env.example must document OMADIA_EXPECT_LOOPBACK so the guard is discoverable',
    );
  });
});
