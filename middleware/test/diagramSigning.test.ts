import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { signUrl, verifySig } from '@omadia/diagrams';

const SECRET = 'a'.repeat(32);

describe('diagram signing', () => {
  it('round-trips a signed URL', () => {
    const url = signUrl({
      key: 'byte5/abc123.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: 'http://localhost:3979',
      nowSec: 1_000_000,
    });
    // /diagrams/<encoded-key>?exp=<unix>&sig=<hex>
    const u = new URL(url);
    assert.equal(u.pathname, `/diagrams/${encodeURIComponent('byte5/abc123.png')}`);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    assert.equal(exp, 1_000_060);
    assert.match(sig, /^[0-9a-f]{64}$/);

    assert.equal(
      verifySig({
        key: 'byte5/abc123.png',
        exp,
        sig,
        secret: SECRET,
        nowSec: 1_000_030,
      }),
      true,
    );
  });

  it('rejects expired signatures', () => {
    const url = signUrl({
      key: 'byte5/abc.png',
      secret: SECRET,
      ttlSec: 10,
      publicBaseUrl: 'http://localhost:3979',
      nowSec: 1_000_000,
    });
    const u = new URL(url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    assert.equal(
      verifySig({
        key: 'byte5/abc.png',
        exp,
        sig,
        secret: SECRET,
        nowSec: 1_000_999, // way past TTL
      }),
      false,
    );
  });

  it('rejects tampered signatures', () => {
    const url = signUrl({
      key: 'byte5/abc.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: 'http://localhost:3979',
      nowSec: 1_000_000,
    });
    const u = new URL(url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    // Flip one nibble.
    const tampered = sig.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    assert.equal(
      verifySig({
        key: 'byte5/abc.png',
        exp,
        sig: tampered,
        secret: SECRET,
        nowSec: 1_000_010,
      }),
      false,
    );
  });

  it('rejects signatures issued for a different key (replay)', () => {
    const url = signUrl({
      key: 'byte5/aaa.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: 'http://localhost:3979',
      nowSec: 1_000_000,
    });
    const u = new URL(url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    // Valid signature for `aaa.png` — try to replay it on `bbb.png`.
    assert.equal(
      verifySig({
        key: 'byte5/bbb.png',
        exp,
        sig,
        secret: SECRET,
        nowSec: 1_000_010,
      }),
      false,
    );
  });

  it('rejects non-hex signatures without throwing', () => {
    assert.equal(
      verifySig({
        key: 'byte5/abc.png',
        exp: 9_999_999_999,
        sig: 'not-hex-at-all',
        secret: SECRET,
      }),
      false,
    );
  });

  it('rejects bogus exp values', () => {
    assert.equal(
      verifySig({
        key: 'byte5/abc.png',
        exp: Number.NaN,
        sig: 'a'.repeat(64),
        secret: SECRET,
      }),
      false,
    );
  });

  it('trims trailing slashes from the base URL', () => {
    const url = signUrl({
      key: 'byte5/abc.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: 'http://localhost:3979///',
      nowSec: 1_000_000,
    });
    assert.ok(!url.includes('//diagrams'));
  });
});
