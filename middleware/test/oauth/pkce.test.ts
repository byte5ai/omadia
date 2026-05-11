import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCodeChallenge,
  generateCodeVerifier,
} from '../../src/plugins/oauth/pkce.js';

test('generateCodeVerifier returns a base64url string of >=43 chars', () => {
  const v = generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/);
  assert.ok(v.length >= 43, `verifier too short: ${v.length}`);
});

test('generateCodeVerifier is non-deterministic', () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.notEqual(a, b);
});

test('computeCodeChallenge matches RFC 7636 §4.4 sample vector', () => {
  // Verifier and expected challenge from RFC 7636 Appendix B.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(computeCodeChallenge(verifier), expected);
});

test('computeCodeChallenge has no padding and is URL-safe', () => {
  const v = generateCodeVerifier();
  const c = computeCodeChallenge(v);
  assert.match(c, /^[A-Za-z0-9_-]+$/);
  assert.ok(!c.includes('='));
  assert.ok(!c.includes('+'));
  assert.ok(!c.includes('/'));
});

test('computeCodeChallenge is deterministic for a given verifier', () => {
  const v = generateCodeVerifier();
  assert.equal(computeCodeChallenge(v), computeCodeChallenge(v));
});
