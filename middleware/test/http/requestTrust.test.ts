/**
 * `TRUSTED_PROXY_ADDRESSES` and `PUBLIC_SCHEME` — who may speak for the client,
 * and what scheme clients reach us over (#1310,
 * docs/security-architecture.md §10o).
 *
 * The parser's job is narrow but load-bearing: it is what stands between
 * `app.set('trust proxy', …)` and the old `true`. The case that matters most
 * is the rejection of a hop COUNT, because a count reads like the obvious fix
 * and is not one — Express counts the immediate peer as a trusted hop, so `1`
 * believes a client that connects directly. `test/http/cookieSecure.test.ts`
 * pins the behaviour that rejection protects.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  describeTrustedProxies,
  isPublicSchemeMode,
  isTrustedProxyList,
  MAX_TRUSTED_PROXIES,
  parseTrustedProxies,
  PUBLIC_SCHEME_MODES,
} from '../../src/http/requestTrust.js';

describe('parseTrustedProxies — trust nothing by default', () => {
  it('reads an unset, empty or whitespace value as trusting no hop', () => {
    assert.equal(parseTrustedProxies(''), false);
    assert.equal(parseTrustedProxies('   '), false);
  });

  it('accepts `none` as the spelled-out form of the same thing', () => {
    assert.equal(parseTrustedProxies('none'), false);
    assert.equal(parseTrustedProxies('NONE'), false);
  });
});

describe('parseTrustedProxies — accepted entries', () => {
  it('takes IPv4 and IPv6 addresses', () => {
    assert.deepEqual(parseTrustedProxies('10.1.2.3'), ['10.1.2.3']);
    assert.deepEqual(parseTrustedProxies('2001:db8::1'), ['2001:db8::1']);
  });

  it('takes IP/bits blocks in both families', () => {
    assert.deepEqual(parseTrustedProxies('127.0.0.0/8'), ['127.0.0.0/8']);
    assert.deepEqual(parseTrustedProxies('2001:db8::/32'), ['2001:db8::/32']);
  });

  it("takes Express's subnet aliases, lower-cased", () => {
    assert.deepEqual(parseTrustedProxies('Loopback'), ['loopback']);
    assert.deepEqual(parseTrustedProxies('linklocal,uniquelocal'), [
      'linklocal',
      'uniquelocal',
    ]);
  });

  it('takes a comma-separated list and trims it', () => {
    assert.deepEqual(parseTrustedProxies(' 10.1.2.3 , loopback ,, 192.0.2.0/24 '), [
      '10.1.2.3',
      'loopback',
      '192.0.2.0/24',
    ]);
  });
});

describe('parseTrustedProxies — rejections', () => {
  it('rejects a hop count, and says why a count is not the fix', () => {
    assert.throws(() => parseTrustedProxies('1'), /not a hop count/);
    assert.throws(() => parseTrustedProxies('2'), /trusted hop #1/);
    assert.throws(() => parseTrustedProxies('10.1.2.3,1'), /not a hop count/);
  });

  it('rejects `true` — the setting this replaced', () => {
    assert.throws(() => parseTrustedProxies('true'), /must be an IP/);
  });

  it('rejects a /0 block — it is `trust proxy = true` wearing a netmask', () => {
    // The hole this closes: a bare `1` was refused with a lecture while
    // `0.0.0.0/0` sailed through and trusted every sender, silently.
    for (const raw of ['0.0.0.0/0', '::/0', '10.1.2.3/0', '0.0.0.0/00']) {
      assert.throws(() => parseTrustedProxies(raw), /refuses a \/0 block/, raw);
    }
  });

  it('still accepts the narrowest real blocks either side of that', () => {
    assert.deepEqual(parseTrustedProxies('0.0.0.0/1'), ['0.0.0.0/1']);
    assert.deepEqual(parseTrustedProxies('10.1.2.3/32'), ['10.1.2.3/32']);
    assert.deepEqual(parseTrustedProxies('::/1'), ['::/1']);
  });

  it('rejects hostnames, junk and a malformed block', () => {
    assert.throws(() => parseTrustedProxies('proxy.internal'), /must be an IP/);
    assert.throws(() => parseTrustedProxies('10.1.2.3/33'), /must be an IP/);
    assert.throws(() => parseTrustedProxies('2001:db8::/129'), /must be an IP/);
    assert.throws(() => parseTrustedProxies('10.1.2.3/'), /must be an IP/);
  });

  it('rejects a list longer than any shipped topology has hops', () => {
    const tooMany = Array.from(
      { length: MAX_TRUSTED_PROXIES + 1 },
      (_, i) => `10.0.0.${String(i + 1)}`,
    ).join(',');

    assert.throws(() => parseTrustedProxies(tooMany), /at most 16 entries/);
  });
});

describe('isTrustedProxyList — the config schema refinement', () => {
  it('is true for every accepted spelling', () => {
    for (const raw of ['', 'none', 'loopback', '10.1.2.3', '127.0.0.0/8,10.1.2.3']) {
      assert.equal(isTrustedProxyList(raw), true, raw);
    }
  });

  it('is false for the rejected ones, so boot reports a config error', () => {
    for (const raw of ['1', 'true', 'proxy.internal', '10.1.2.3/33']) {
      assert.equal(isTrustedProxyList(raw), false, raw);
    }
  });
});

describe('describeTrustedProxies — the boot log line', () => {
  it('round-trips a list, and names the empty setting', () => {
    assert.equal(describeTrustedProxies(false), 'none');
    assert.equal(describeTrustedProxies(['loopback']), 'loopback');
    assert.equal(
      describeTrustedProxies(parseTrustedProxies('10.1.2.3, loopback')),
      '10.1.2.3,loopback',
    );
  });
});

describe('isPublicSchemeMode — the config schema refinement', () => {
  it('accepts exactly the three modes, trimmed', () => {
    assert.deepEqual([...PUBLIC_SCHEME_MODES], ['auto', 'https', 'http']);
    for (const raw of ['auto', 'https', 'http', ' auto ', 'https  ']) {
      assert.equal(isPublicSchemeMode(raw), true, raw);
    }
  });

  it('rejects anything else, so a typo is a boot error and not a silent default', () => {
    // `always`/`never` were this setting's first spelling; a stale .env must
    // fail loudly rather than fall through to `auto` and drop the Secure flag.
    for (const raw of ['always', 'never', 'true', 'HTTPS', 'wss', '', 'maybe']) {
      assert.equal(isPublicSchemeMode(raw), false, JSON.stringify(raw));
    }
  });
});
