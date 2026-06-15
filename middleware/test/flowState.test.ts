/**
 * Spec 004 Phase B (FR-B3 / SC3) — plugin-audience-bound flow-state tokens.
 *
 * The state token is the CSRF guard for a plugin's redirect round-trip. These
 * tests pin the two security-critical properties: a token minted for one
 * plugin must NOT verify for another (audience binding), and an expired token
 * must be rejected.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';

import { SignJWT } from 'jose';

import {
  flowAudience,
  signFlowState,
  verifyFlowState,
} from '../src/platform/flowState.js';

const KEY = new Uint8Array(crypto.randomBytes(64));
const OTHER_KEY = new Uint8Array(crypto.randomBytes(64));

describe('Spec 004 — flow-state round-trip', () => {
  it('verifies a token signed for the same plugin and returns the claims', async () => {
    const token = await signFlowState('@omadia/integration-github', { nonce: 'abc', n: 1 }, KEY);
    const claims = await verifyFlowState('@omadia/integration-github', token, KEY);
    assert.equal(claims['nonce'], 'abc');
    assert.equal(claims['n'], 1);
    assert.equal(claims['aud'], 'plugin:@omadia/integration-github');
    assert.equal(claims['iss'], 'omadia');
  });
});

describe('Spec 004 — flow-state audience binding (SC3b)', () => {
  it('rejects a token signed for a DIFFERENT plugin id', async () => {
    const token = await signFlowState('plugin-a', { nonce: 'x' }, KEY);
    await assert.rejects(
      () => verifyFlowState('plugin-b', token, KEY),
      /audience|aud/i,
    );
  });

  it('rejects a token signed with a different key', async () => {
    const token = await signFlowState('plugin-a', { nonce: 'x' }, KEY);
    await assert.rejects(() => verifyFlowState('plugin-a', token, OTHER_KEY));
  });

  it('binds the audience as plugin:<id>', () => {
    assert.equal(flowAudience('plugin-a'), 'plugin:plugin-a');
  });
});

describe('Spec 004 — flow-state expiry (SC3a)', () => {
  it('rejects an expired token', async () => {
    // Mint a token whose exp is already in the past — same iss/aud the verifier
    // expects, so only the TTL check can reject it.
    const past = Math.floor(Date.now() / 1000) - 120;
    const expired = await new SignJWT({ nonce: 'x' })
      .setProtectedHeader({ alg: 'HS512' })
      .setIssuer('omadia')
      .setAudience(flowAudience('plugin-a'))
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(KEY);
    await assert.rejects(
      () => verifyFlowState('plugin-a', expired, KEY),
      /exp|expired/i,
    );
  });

  it('honours a custom TTL', async () => {
    const token = await signFlowState('plugin-a', { nonce: 'x' }, KEY, '30m');
    const claims = await verifyFlowState('plugin-a', token, KEY);
    const ttl = (claims['exp'] as number) - (claims['iat'] as number);
    assert.equal(ttl, 30 * 60);
  });
});
