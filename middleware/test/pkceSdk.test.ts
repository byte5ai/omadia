/**
 * Spec 004 Phase B (FR-B4) — PKCE helpers are exported as pure SDK functions
 * from `@omadia/plugin-api`, so plugins running their own redirect flows mint
 * a verifier/challenge pair without reaching into the kernel.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { generateCodeVerifier, computeCodeChallenge } from '@omadia/plugin-api';

test('SDK PKCE matches RFC 7636 Appendix B sample vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(computeCodeChallenge(verifier), expected);
});

test('SDK generateCodeVerifier is URL-safe and >=43 chars', () => {
  const v = generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/);
  assert.ok(v.length >= 43);
});
