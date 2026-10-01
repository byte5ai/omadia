/**
 * The two account identities of the password sign-in limiter
 * (docs/security-architecture.md §10m, `src/auth/loginAccount.ts`):
 *
 *  - the bucket key folds an address at least as coarsely as the users table
 *    matches it (`LOWER(email) = LOWER($input)`), whatever LOWER() the
 *    database applies: one case per character the shipped databases fold
 *    differently from JavaScript, plus a property over a corpus against every
 *    LOWER() variant a Postgres collation can apply;
 *  - the device key changes nothing but ASCII case, so the users-table lookup
 *    of it lands where the lookup of the address itself does.
 *
 * loginAccountFold.pg.test.ts runs the same property against real Postgres.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  foldLoginAccountId,
  isSameLoginAccount,
  loginAccountKey,
  loginDeviceAccountKey,
  loginDeviceAccountName,
  readLoginAccountId,
} from '../../src/auth/loginAccount.js';
import { accountSpellings } from './accountSpellings.js';

const key = (email: string): string => loginAccountKey('local', email);

// ─── LOWER() as Postgres collations apply it ───────────────────────────────

/** libc (en_US.UTF-8) and the builtin C.UTF-8 provider: simple mapping, one code point at a time. */
const simpleLower = (s: string): string =>
  Array.from(s, (c) => (c === '\u0130' ? 'i' : c.toLowerCase())).join('');
/** ICU and PG_UNICODE_FAST: full mapping with context, as JavaScript does it. */
const fullLower = (s: string): string => s.toLowerCase();
/** A Turkish or Azerbaijani collation: 'I' is the dotless 'ı', 'İ' the plain 'i'. */
const turkicLower = (s: string): string =>
  Array.from(s, (c) => (c === 'I' ? '\u0131' : c === '\u0130' ? 'i' : c.toLowerCase())).join('');
/** A Lithuanian collation: a capital I or J keeps a dot when an accent above follows. */
const lithuanianLower = (s: string): string =>
  s.replace(/[IJ](?=[\u0300-\u0314])/g, (c) => `${c.toLowerCase()}\u0307`).toLowerCase();
/** The C collation: ASCII only. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const LOWER_VARIANTS = { simpleLower, fullLower, turkicLower, lithuanianLower, asciiLower } as const;

const corpus = accountSpellings;

describe('bucket key: one key for every spelling the users table treats as one account', () => {
  it('folds a capital dotted \u0130 (U+0130) to a plain i, as Postgres LOWER() does', () => {
    assert.equal(key('adm\u0130n@example.com'), key('admin@example.com'));
    assert.equal(key('ADM\u0130N@EXAMPLE.COM'), 'local:admin@example.com');
  });

  it('drops the combining dot JavaScript adds, and folds the dotless \u0131', () => {
    assert.equal(key('admi\u0307n@example.com'), key('admin@example.com'));
    assert.equal(key('adm\u0131n@example.com'), key('admin@example.com'));
  });

  it('folds a final \u03c2 and a capital \u03a3 to \u03c3 wherever they stand', () => {
    const sigma = key('\u03b1\u03c3@example.com');
    assert.equal(key('\u0391\u03a3@EXAMPLE.COM'), sigma);
    assert.equal(key('\u03b1\u03c2@example.com'), sigma);
    assert.equal(key('\u03c3\u03b1@example.com'), key('\u03a3\u0391@example.com'));
  });

  it('folds compatibility forms (NFKD): fullwidth letters, ligatures, the Kelvin sign', () => {
    assert.equal(key('\uff41\uff44\uff4d\uff49\uff4e@example.com'), key('admin@example.com'));
    assert.equal(key('\ufb01nance@example.com'), key('finance@example.com'));
    assert.equal(key('\u212aelvin@example.com'), key('kelvin@example.com'));
  });

  it('folds precomposed and decomposed accents alike, and drops them', () => {
    const plain = key('elise@example.com');
    assert.equal(key('\u00e9lise@example.com'), plain);
    assert.equal(key('e\u0301lise@example.com'), plain);
    assert.equal(key('\u00c9LISE@EXAMPLE.COM'), plain);
  });

  it('trims like the provider and namespaces by provider', () => {
    assert.equal(key(' Admin@Example.COM '), 'local:admin@example.com');
    assert.equal(loginAccountKey('other', 'admin@example.com'), 'other:admin@example.com');
  });

  it("collapses a missing, empty or oversized id to '-', and never folds a huge one", () => {
    assert.equal(loginAccountKey('local', undefined), 'local:-');
    assert.equal(key('   '), 'local:-');
    assert.equal(key(`${'a'.repeat(250)}@x.de`), 'local:-');
    assert.equal(foldLoginAccountId('x'.repeat(5_000_000)), undefined);
  });

  it('is stable: folding a folded id changes nothing', () => {
    for (const s of corpus()) {
      const folded = foldLoginAccountId(s);
      assert.ok(folded);
      assert.equal(foldLoginAccountId(folded), folded, JSON.stringify(s));
    }
  });

  for (const [name, lower] of Object.entries(LOWER_VARIANTS)) {
    it(`never splits what ${name} merges`, () => {
      const spellings = corpus();
      for (const a of spellings) {
        for (const b of spellings) {
          if (lower(a.trim()) === lower(b.trim())) {
            assert.equal(key(a), key(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
          }
        }
      }
    });
  }

  it('isSameLoginAccount compares bucket keys', () => {
    assert.equal(isSameLoginAccount('local', 'admin@example.com', 'ADM\u0130N@example.com'), true);
    assert.equal(isSameLoginAccount('local', 'admin@example.com', 'adm\u200bin@example.com'), false);
  });
});

describe('device key: the address as stored, ASCII case aside', () => {
  it('lower-cases ASCII letters and leaves every other character alone', () => {
    assert.equal(loginDeviceAccountName(' Admin@Example.COM '), 'admin@example.com');
    assert.equal(loginDeviceAccountName('ADM\u0130N@X.DE'), 'adm\u0130n@x.de');
    assert.equal(loginDeviceAccountName('\u00c9lise@X.de'), '\u00c9lise@x.de');
    assert.equal(loginDeviceAccountKey('local', 'Admin@X.de'), 'local:admin@x.de');
  });

  it('keeps apart two accounts the bucket key lumps together', () => {
    const a = 'iiii@example.com';
    const b = 'i\u0307iii@example.com';
    assert.equal(key(a), key(b), 'one bucket');
    assert.notEqual(loginDeviceAccountKey('local', a), loginDeviceAccountKey('local', b));
  });

  it('is undefined for a missing, empty or oversized id', () => {
    assert.equal(loginDeviceAccountKey('local', undefined), undefined);
    assert.equal(loginDeviceAccountKey('local', '  '), undefined);
    assert.equal(loginDeviceAccountKey('local', `${'a'.repeat(250)}@x.de`), undefined);
  });

  // Collations that lower-case a capital I their own way are the exception:
  // Turkish and Azerbaijani make it the dotless ı, Lithuanian adds a dot
  // before an accent above (§10m residual risks).
  for (const name of ['simpleLower', 'fullLower', 'asciiLower'] as const) {
    it(`finds under ${name} what the address itself finds`, () => {
      const lower = LOWER_VARIANTS[name];
      for (const s of corpus()) {
        const deviceName = loginDeviceAccountName(s);
        assert.ok(deviceName);
        assert.equal(lower(deviceName), lower(s.trim()), JSON.stringify(s));
      }
    });
  }
});

describe('readLoginAccountId', () => {
  it('reads the account id from the login body: email, else username', () => {
    assert.equal(readLoginAccountId({ email: 'a@x', password: 'p' }), 'a@x');
    assert.equal(readLoginAccountId({ username: 'bob', password: 'p' }), 'bob');
    assert.equal(readLoginAccountId({ email: 42 }), undefined);
    assert.equal(readLoginAccountId(undefined), undefined);
    assert.equal(readLoginAccountId('a@x'), undefined);
  });
});
