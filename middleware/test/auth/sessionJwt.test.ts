import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

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
