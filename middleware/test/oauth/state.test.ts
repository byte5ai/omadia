import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  signOAuthState,
  verifyOAuthState,
} from '../../src/plugins/oauth/state.js';

function freshKey(): Uint8Array {
  return new Uint8Array(crypto.randomBytes(64));
}

const sampleClaims = {
  flowId: 'flow-123',
  jobId: 'job-456',
  providerId: 'microsoft365',
  fieldKey: 'ms365',
};

test('signOAuthState + verifyOAuthState round-trip', async () => {
  const key = freshKey();
  const token = await signOAuthState(sampleClaims, key);
  const out = await verifyOAuthState(token, key);
  assert.deepEqual(out, sampleClaims);
});

test('verify fails with wrong key', async () => {
  const key = freshKey();
  const wrongKey = freshKey();
  const token = await signOAuthState(sampleClaims, key);
  await assert.rejects(() => verifyOAuthState(token, wrongKey));
});

test('verify fails for tampered token', async () => {
  const key = freshKey();
  const token = await signOAuthState(sampleClaims, key);
  // JWT shape is header.payload.signature. Mutating a char inside the
  // payload (not the signature tail — that has padding bits that can be
  // no-ops) forces an HMAC mismatch on verify.
  const [h, p, s] = token.split('.');
  const flippedPayload =
    p.slice(0, 5) + (p[5] === 'A' ? 'B' : 'A') + p.slice(6);
  const mangled = `${h}.${flippedPayload}.${s}`;
  await assert.rejects(() => verifyOAuthState(mangled, key));
});

test('verify fails for expired token', async () => {
  const key = freshKey();
  const token = await signOAuthState(sampleClaims, key, '1s');
  await new Promise((r) => setTimeout(r, 1100));
  await assert.rejects(() => verifyOAuthState(token, key));
});

test('verify fails when a required claim is missing', async () => {
  const key = freshKey();
  const incomplete = {
    flowId: 'flow-1',
    jobId: '',
    providerId: 'microsoft365',
    fieldKey: 'ms365',
  };
  const token = await signOAuthState(incomplete, key);
  await assert.rejects(
    () => verifyOAuthState(token, key),
    /missing required claims/,
  );
});

test('verify rejects JWTs without the plugin-oauth audience', async () => {
  // Login-session tokens (auth/sessionJwt.ts) share the signing key but
  // do NOT set audience='plugin-oauth'. The audience claim is what
  // isolates the two token populations — confirm a login-shaped token
  // is rejected here.
  const key = freshKey();
  const { SignJWT } = await import('jose');
  const intruder = await new SignJWT({
    flowId: 'x',
    jobId: 'y',
    providerId: 'z',
    fieldKey: 'w',
  })
    .setProtectedHeader({ alg: 'HS512' })
    .setIssuer('omadia')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
  await assert.rejects(() => verifyOAuthState(intruder, key));
});
