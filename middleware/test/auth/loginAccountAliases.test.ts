/**
 * Spellings of one account in the password sign-in limiter
 * (docs/security-architecture.md §10f), driven through the real auth router
 * over a users table that matches addresses the way Postgres `LOWER()` does
 * (`pgLower` in the harness; loginAccountFold.pg.test.ts checks real
 * Postgres).
 *
 * Postgres folds 'İ' (U+0130) to 'i' and every 'Σ' to 'σ', where JavaScript's
 * toLowerCase() gives 'i' plus U+0307 and, at the end of a word, 'ς'. Two
 * identities have to stay apart:
 *
 *  - the limiter's account key must fold at least as coarsely as the users
 *    table, or every such spelling of an address opens a budget of its own;
 *  - a device cookie must belong to the account that actually signed in, not
 *    to the spelling typed, or signing in to one account mints a known
 *    browser for another.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  assertRateLimited,
  deviceCookieFrom,
  harness,
  login,
  right,
  wrong,
  type RequestExtras,
} from './loginHarness.js';

/** The web-ui container, as the middleware sees every browser behind it. */
const PROXY: RequestExtras = { remoteAddress: '10.0.0.5' };
const FREE = 5;

/** Every spelling of `local` with each 'i' either plain or as U+0130. */
function dottedSpellings(local: string, domain: string): string[] {
  const positions = [...local].flatMap((c, i) => (c === 'i' ? [i] : []));
  return Array.from({ length: 2 ** positions.length }, (_, mask) => {
    const chars = [...local];
    positions.forEach((at, bit) => {
      if (mask & (1 << bit)) chars[at] = '\u0130';
    });
    return `${chars.join('')}@${domain}`;
  });
}

describe('one account, many spellings: one budget', () => {
  it('a capital dotted \u0130 does not open a second budget for an address', async () => {
    const h = await harness();
    const spellings = [
      'adm\u0130n@example.com',
      'ADM\u0130N@EXAMPLE.COM',
      'admin@example.com',
      'Adm\u0130n@Example.com',
      ' adm\u0130n@example.com ',
    ];
    for (const email of spellings) {
      assert.equal((await login(h, wrong(email), PROXY)).status, 401, email);
    }
    assertRateLimited(await login(h, wrong('admin@example.com'), PROXY));
    assertRateLimited(await login(h, wrong('adm\u0130n@example.com'), PROXY));
    assert.equal(h.verifies.calls, FREE, 'five guesses reached argon2, not more');
  });

  it('while that budget is spent, the right password is refused under every spelling', async () => {
    const h = await harness();
    for (let i = 0; i < FREE; i += 1) await login(h, wrong(), PROXY);
    for (const email of ['adm\u0130n@example.com', 'ADMIN@EXAMPLE.COM']) {
      assertRateLimited(await login(h, right(email), PROXY));
    }
  });

  it('2^k spellings of an address with k i’s still get five guesses in all', async () => {
    const h = await harness();
    await h.store.addLocalUser('iiii@example.com', 'a long synthetic passphrase');
    const spellings = dottedSpellings('iiii', 'example.com');
    assert.equal(spellings.length, 16);

    let admitted = 0;
    for (const email of spellings) {
      for (let i = 0; i < 2; i += 1) {
        if ((await login(h, wrong(email), PROXY)).status === 401) admitted += 1;
      }
    }
    assert.equal(admitted, FREE);
  });

  it('a word-final capital \u03a3 is the same account as a lower-case \u03c3', async () => {
    const h = await harness();
    await h.store.addLocalUser('\u03b1\u03c3@example.com', 'another synthetic passphrase');
    for (const email of ['\u03b1\u03c3@example.com', '\u0391\u03a3@EXAMPLE.COM']) {
      for (let i = 0; i < 3; i += 1) await login(h, wrong(email), PROXY);
    }
    assertRateLimited(await login(h, wrong('\u03b1\u03c3@example.com'), PROXY));
  });
});

describe('a device cookie belongs to the account that signed in', () => {
  // Two accounts the users table keeps apart: Postgres lower-cases A's
  // spelling with a capital İ to A's address, and B's combining dot stays.
  const A = 'iiii@example.com';
  const B = 'i\u0307iii@example.com';
  const A_ALIAS = '\u0130iii@example.com';
  const A_PASSWORD = 'account a synthetic passphrase';
  const B_PASSWORD = 'account b synthetic passphrase';

  async function twoAccounts() {
    const h = await harness();
    await h.store.addLocalUser(A, A_PASSWORD);
    await h.store.addLocalUser(B, B_PASSWORD);
    assert.notEqual(h.store.idOf(A), h.store.idOf(B), 'two rows');
    assert.equal(h.store.idOf(A_ALIAS), h.store.idOf(A), 'the alias is A to the users table');
    return h;
  }

  it('signing in to A with another spelling buys nothing for B', async () => {
    const h = await twoAccounts();
    const signedIn = await login(h, right(A_ALIAS, A_PASSWORD), PROXY);
    assert.equal(signedIn.status, 200);
    const device = deviceCookieFrom(signedIn);

    // B's guesses from the shared address use up its budget...
    for (let i = 0; i < FREE; i += 1) await login(h, wrong(B), PROXY);
    assertRateLimited(await login(h, wrong(B), PROXY));
    // ...and A's cookie is not a known browser of B.
    assertRateLimited(await login(h, wrong(B), { ...PROXY, headers: { cookie: device } }));
    assertRateLimited(await login(h, right(B, B_PASSWORD), { ...PROXY, headers: { cookie: device } }));

    // It is one of A's known browsers, under A's address as stored.
    const back = await login(h, right(A, A_PASSWORD), { ...PROXY, headers: { cookie: device } });
    assert.equal(back.status, 200);
  });
});
