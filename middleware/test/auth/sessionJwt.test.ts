import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SignJWT } from 'jose';

import { signSession, verifySession } from '../../src/auth/sessionJwt.js';

/**
 * Guards the OB session-expiry-UX change: `verifySession` must surface the
 * JWT `exp`/`iat` timestamps so GET /api/v1/auth/me can hand the Admin UI
 * a real expiry to count down to. Identity-only callers are unaffected.
 */

// HS512 requires a key of at least 64 bytes.
const KEY = new TextEncoder().encode('x'.repeat(64));

describe('sessionJwt — verifySession surfaces JWT timestamps', () => {
  it('returns numeric exp/iat alongside the identity claims', async () => {
    const beforeSign = Math.floor(Date.now() / 1000);
    const token = await signSession(
      {
        sub: 'u1',
        email: 'admin@example.de',
        display_name: 'Admin Example',
        role: 'admin',
        provider: 'entra',
      },
      KEY,
      '4h',
    );

    const verified = await verifySession(token, KEY);

    assert.equal(verified.sub, 'u1');
    assert.equal(verified.email, 'admin@example.de');
    assert.equal(verified.provider, 'entra');

    assert.equal(typeof verified.exp, 'number');
    assert.equal(typeof verified.iat, 'number');
    // `iat` is stamped at signing time.
    assert.ok(verified.iat >= beforeSign);
    // `exp` is the 4h window past `iat` — allow ±2s scheduling slack.
    const FOUR_HOURS_S = 4 * 60 * 60;
    assert.ok(Math.abs(verified.exp - verified.iat - FOUR_HOURS_S) <= 2);
  });
});

/**
 * #965 — `auth_time` records the ORIGINAL sign-in and survives renewal
 * re-mints, so the renewal chain can be capped. Legacy tokens without the
 * claim fall back to `iat` (the maintainer's decision).
 */
describe('sessionJwt — auth_time (#965)', () => {
  const BASE = {
    sub: 'u1',
    email: 'admin@example.de',
    display_name: 'Admin Example',
    role: 'admin' as const,
    provider: 'local',
  };

  it('stamps auth_time = iat when the input carries none', async () => {
    const token = await signSession(BASE, KEY, '4h');
    const verified = await verifySession(token, KEY);
    assert.equal(typeof verified.auth_time, 'number');
    assert.ok(Math.abs(verified.auth_time - verified.iat) <= 1);
  });

  it('keeps an explicit auth_time across a sign/verify round trip', async () => {
    const authTime = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
    const token = await signSession({ ...BASE, auth_time: authTime }, KEY, '4h');
    const verified = await verifySession(token, KEY);
    assert.equal(verified.auth_time, authTime);
    assert.ok(verified.iat > authTime, 'iat is the re-mint time, not auth_time');
  });

  it('accepts an absolute epoch as expiresIn (renewal clamps exp to the cap)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 90 * 60;
    const token = await signSession(BASE, KEY, exp);
    const verified = await verifySession(token, KEY);
    assert.equal(verified.exp, exp);
  });

  it('falls back to iat for a legacy token without auth_time', async () => {
    const iat = Math.floor(Date.now() / 1000) - 60 * 60;
    const legacy = await new SignJWT({ ...BASE })
      .setProtectedHeader({ alg: 'HS512' })
      .setIssuer('omadia')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 4 * 60 * 60)
      .sign(KEY);
    const verified = await verifySession(legacy, KEY);
    assert.equal(verified.iat, iat);
    assert.equal(verified.auth_time, iat);
  });
});
