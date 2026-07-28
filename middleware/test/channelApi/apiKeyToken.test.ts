import { strict as assert } from 'node:assert';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  API_KEY_PREFIX,
  mintApiKey,
  sha256Hex,
  verifyApiKey,
} from '../../packages/harness-channel-api/src/apiKeyToken.js';

/**
 * Issue #438 — pure-unit coverage for the API-key token, mirroring
 * `test/devplatform/jobToken.test.ts` (the closest existing precedent for a
 * hashed, constant-time-verified bearer credential in this codebase).
 */
describe('channelApi/apiKeyToken', () => {
  it('mints `omk_` + 32 random bytes base64url, and stores only the sha256 hex', () => {
    const { token, hash } = mintApiKey();
    assert.ok(token.startsWith(API_KEY_PREFIX), 'has the omk_ prefix');
    const b64 = token.slice(API_KEY_PREFIX.length);
    assert.equal(Buffer.from(b64, 'base64url').length, 32, '32 random bytes');
    assert.match(hash, /^[0-9a-f]{64}$/, 'hash is 64 hex chars (sha256)');
    assert.equal(hash, createHash('sha256').update(token, 'utf8').digest('hex'));
    assert.ok(!hash.includes(token), 'the plaintext is not embedded in the hash');
  });

  it('mints distinct keys', () => {
    const a = mintApiKey();
    const b = mintApiKey();
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.hash, b.hash);
  });

  it('verifies a key against its own stored hash (round-trip)', () => {
    const { token, hash } = mintApiKey();
    assert.equal(verifyApiKey(token, hash), true);
  });

  it('rejects a wrong key of the same length without leaking via a throw', () => {
    const { hash } = mintApiKey();
    const other = mintApiKey().token;
    assert.equal(verifyApiKey(other, hash), false);
  });

  it('rejects mismatches at the FIRST character and at the LAST character identically', () => {
    // Not a timing assertion (that would be flaky) — just confirms the
    // observable outcome doesn't depend on where the difference sits, which
    // is a prerequisite for (not proof of) constant-time behaviour. The
    // "doesn't early-return" guarantee itself comes from delegating to
    // `crypto.timingSafeEqual`, asserted structurally below.
    const { token, hash } = mintApiKey();
    const mismatchAtStart = 'X' + token.slice(1);
    const mismatchAtEnd = token.slice(0, -1) + (token.endsWith('X') ? 'Y' : 'X');
    assert.equal(verifyApiKey(mismatchAtStart, hash), false);
    assert.equal(verifyApiKey(mismatchAtEnd, hash), false);
  });

  it('does not throw and returns false when the presented key length differs', () => {
    const { hash } = mintApiKey();
    assert.equal(verifyApiKey('x', hash), false);
    assert.equal(verifyApiKey('', hash), false);
    assert.equal(verifyApiKey(API_KEY_PREFIX + 'A'.repeat(500), hash), false);
  });

  it('returns false for a null/empty/malformed stored hash without throwing', () => {
    const { token } = mintApiKey();
    assert.equal(verifyApiKey(token, null), false);
    assert.equal(verifyApiKey(token, undefined), false);
    assert.equal(verifyApiKey(token, ''), false);
    assert.equal(verifyApiKey(token, 'zzzz'), false);
    assert.equal(verifyApiKey(token, 'abc'), false);
  });

  it('sha256Hex is stable and matches node crypto', () => {
    assert.equal(sha256Hex('omadia'), createHash('sha256').update('omadia', 'utf8').digest('hex'));
  });

  it('the source delegates the actual comparison to crypto.timingSafeEqual, not a naive === / early-exit loop', () => {
    // Structural, deterministic check (no wall-clock timing, per the issue's
    // own guidance) that the comparison primitive is Node's constant-time
    // buffer compare rather than a hand-rolled loop that could short-circuit
    // on the first differing byte.
    const src = readFileSync(
      fileURLToPath(new URL('../../packages/harness-channel-api/src/apiKeyToken.ts', import.meta.url)),
      'utf8',
    );
    assert.match(src, /timingSafeEqual\(actual, expected\)/, 'verifyApiKey must call timingSafeEqual');
    assert.doesNotMatch(
      src,
      /actual\s*===\s*expected|expected\s*===\s*actual/,
      'must not fall back to a plain === compare of the hash buffers',
    );

    // Cross-check: for equal-length buffers, our function's result always
    // agrees with a direct timingSafeEqual call — i.e. it is not silently
    // adding its own early-exit logic ON TOP of the primitive.
    const { token, hash } = mintApiKey();
    const wrong = mintApiKey().hash;
    const actual = Buffer.from(sha256Hex(token), 'hex');
    assert.equal(verifyApiKey(token, hash), timingSafeEqual(actual, Buffer.from(hash, 'hex')));
    assert.equal(verifyApiKey(token, wrong), timingSafeEqual(actual, Buffer.from(wrong, 'hex')));
  });
});
