import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  signSession,
  verifySession,
  type SessionClaims,
} from '../src/auth/sessionJwt.js';

/**
 * Slice 1b-channel-web — session JWT carries the cluster-root
 * `omadia_user_id` after a successful Admin-UI login. Three surfaces:
 *
 *   1. JWT round-trip preserves the field when present.
 *   2. Old tokens without the field still verify (backward-compat).
 *   3. Empty / non-string values are normalised to undefined.
 *
 * The chat.ts precedence (req.session.omadia_user_id > x-user-id
 * header) is exercised by the live login smoke
 * (`scripts/smoke/slice-1b-web-login.ts`) and not here — that path
 * threads through Express middleware + cookie parsing, which is what
 * the smoke is for.
 */

const KEY = new Uint8Array(randomBytes(64));

describe('Slice 1b-channel-web · sessionJwt omadia_user_id round-trip', () => {
  const base: SessionClaims = {
    sub: 'aad-oid-test',
    email: 'alice@example.com',
    display_name: 'Alice',
    role: 'admin',
    provider: 'entra',
  };

  it('preserves omadia_user_id across sign+verify', async () => {
    const omadiaUserId = '11111111-2222-3333-4444-555555555555';
    const token = await signSession(
      { ...base, omadia_user_id: omadiaUserId },
      KEY,
    );
    const verified = await verifySession(token, KEY);
    assert.equal(verified.omadia_user_id, omadiaUserId);
  });

  it('verifies legacy tokens without omadia_user_id (backward-compat)', async () => {
    const token = await signSession(base, KEY);
    const verified = await verifySession(token, KEY);
    assert.equal(verified.omadia_user_id, undefined);
    assert.equal(verified.provider, 'entra');
    assert.equal(verified.sub, 'aad-oid-test');
  });

  it('drops empty-string omadia_user_id (treats as undefined)', async () => {
    const token = await signSession(
      { ...base, omadia_user_id: '' },
      KEY,
    );
    const verified = await verifySession(token, KEY);
    assert.equal(verified.omadia_user_id, undefined);
  });

  it('works for both providers (local + entra)', async () => {
    const omadiaUserId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const localToken = await signSession(
      {
        sub: 'alice@example.com',
        email: 'alice@example.com',
        display_name: 'Alice',
        role: 'admin',
        provider: 'local',
        omadia_user_id: omadiaUserId,
      },
      KEY,
    );
    const local = await verifySession(localToken, KEY);
    assert.equal(local.provider, 'local');
    assert.equal(local.omadia_user_id, omadiaUserId);
  });
});
