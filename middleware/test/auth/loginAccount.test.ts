/**
 * The two account identities of the password sign-in limiter
 * (docs/security-architecture.md §10f, `src/auth/loginAccount.ts`):
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
  Array.from(s, (c) => (c === 'İ' ? 'i' : c.toLowerCase())).join('');
/** ICU and PG_UNICODE_FAST: full mapping with context, as JavaScript does it. */
const fullLower = (s: string): string => s.toLowerCase();
/** A Turkish or Azerbaijani collation: 'I' is the dotless 'ı', 'İ' the plain 'i'. */
const turkicLower = (s: string): string =>
  Array.from(s, (c) => (c === 'I' ? 'ı' : c === 'İ' ? 'i' : c.toLowerCase())).join('');
/** The C collation: ASCII only. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const LOWER_VARIANTS = { simpleLower, fullLower, turkicLower, asciiLower } as const;

const corpus = accountSpellings;

describe('bucket key: one key for every spelling the users table treats as one account', () => {
  it('folds a capital dotted İ (U+0130) to a plain i, as Postgres LOWER() does', () => {
    assert.equal(key('admİn@example.com'), key('admin@example.com'));
    assert.equal(key('ADMİN@EXAMPLE.COM'), 'local:admin@example.com');
  });

  it('drops the combining dot JavaScript adds, and folds the dotless ı', () => {
    assert.equal(key('admi̇n@example.com'), key('admin@example.com'));
    assert.equal(key('admın@example.com'), key('admin@example.com'));
  });

  it('folds a final ς and a capital Σ to σ wherever they stand', () => {
    const sigma = key('ασ@example.com');
    assert.equal(key('ΑΣ@EXAMPLE.COM'), sigma);
    assert.equal(key('ας@example.com'), sigma);
    assert.equal(key('σα@example.com'), key('ΣΑ@example.com'));
  });

  it('folds compatibility forms (NFKD): fullwidth letters, ligatures, the Kelvin sign', () => {
    assert.equal(key('ａｄｍｉｎ@example.com'), key('admin@example.com'));
    assert.equal(key('ﬁnance@example.com'), key('finance@example.com'));
    assert.equal(key('Kelvin@example.com'), key('kelvin@example.com'));
  });

  it('folds precomposed and decomposed accents alike, and drops them', () => {
    const plain = key('elise@example.com');
    assert.equal(key('élise@example.com'), plain);
    assert.equal(key('élise@example.com'), plain);
    assert.equal(key('ÉLISE@EXAMPLE.COM'), plain);
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
    assert.equal(isSameLoginAccount('local', 'admin@example.com', 'ADMİN@example.com'), true);
    assert.equal(isSameLoginAccount('local', 'admin@example.com', 'adm​in@example.com'), false);
  });
});

describe('device key: the address as stored, ASCII case aside', () => {
  it('lower-cases ASCII letters and leaves every other character alone', () => {
    assert.equal(loginDeviceAccountName(' Admin@Example.COM '), 'admin@example.com');
    assert.equal(loginDeviceAccountName('ADMİN@X.DE'), 'admİn@x.de');
    assert.equal(loginDeviceAccountName('Élise@X.de'), 'Élise@x.de');
    assert.equal(loginDeviceAccountKey('local', 'Admin@X.de'), 'local:admin@x.de');
  });

  it('keeps apart two accounts the bucket key lumps together', () => {
    const a = 'iiii@example.com';
    const b = 'i̇iii@example.com';
    assert.equal(key(a), key(b), 'one bucket');
    assert.notEqual(loginDeviceAccountKey('local', a), loginDeviceAccountKey('local', b));
  });

  it('is undefined for a missing, empty or oversized id', () => {
    assert.equal(loginDeviceAccountKey('local', undefined), undefined);
    assert.equal(loginDeviceAccountKey('local', '  '), undefined);
    assert.equal(loginDeviceAccountKey('local', `${'a'.repeat(250)}@x.de`), undefined);
  });

  // The Turkic LOWER() is the exception: it folds a capital I to the dotless ı.
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
