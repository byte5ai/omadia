import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  RUNNER_TOKEN_PREFIX,
  hashRunnerToken,
  mintRunnerToken,
  sha256Hex,
  verifyRunnerToken,
} from '../../src/devplatform/jobToken.js';

/**
 * Epic #470 W0 — pure-unit coverage for the one-time runner token (spec §4):
 * mint format, verify round-trip, wrong-token rejection, and the guarantee that
 * `timingSafeEqual` never throws on a length mismatch.
 */
describe('devplatform/jobToken', () => {
  it('mints `djr_` + 32 random bytes base64url, and stores only the sha256 hex', () => {
    const { token, hash } = mintRunnerToken();
    assert.ok(token.startsWith(RUNNER_TOKEN_PREFIX), 'has the djr_ prefix');
    const b64 = token.slice(RUNNER_TOKEN_PREFIX.length);
    assert.equal(Buffer.from(b64, 'base64url').length, 32, '32 random bytes');
    assert.match(hash, /^[0-9a-f]{64}$/, 'hash is 64 hex chars (sha256)');
    assert.equal(hash, createHash('sha256').update(token, 'utf8').digest('hex'));
    assert.ok(!hash.includes(token), 'the plaintext is not embedded in the hash');
  });

  it('mints distinct tokens', () => {
    const a = mintRunnerToken();
    const b = mintRunnerToken();
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.hash, b.hash);
  });

  it('verifies a token against its own stored hash (round-trip)', () => {
    const { token, hash } = mintRunnerToken();
    assert.equal(verifyRunnerToken(token, hash), true);
    assert.equal(hashRunnerToken(token), hash, 'hashRunnerToken matches the minted hash');
  });

  it('rejects a wrong token of the same length without leaking via a throw', () => {
    const { hash } = mintRunnerToken();
    const other = mintRunnerToken().token;
    assert.equal(verifyRunnerToken(other, hash), false);
  });

  it('does not throw and returns false when the presented token length differs', () => {
    const { hash } = mintRunnerToken();
    // Short token, empty token, and an over-long token: all must be a quiet false.
    assert.equal(verifyRunnerToken('x', hash), false);
    assert.equal(verifyRunnerToken('', hash), false);
    assert.equal(verifyRunnerToken('djr_' + 'A'.repeat(500), hash), false);
  });

  it('returns false for a null/empty/malformed stored hash without throwing', () => {
    const { token } = mintRunnerToken();
    assert.equal(verifyRunnerToken(token, null), false);
    assert.equal(verifyRunnerToken(token, undefined), false);
    assert.equal(verifyRunnerToken(token, ''), false);
    // Odd-length / non-hex stored hash must not blow up the hex decode path.
    assert.equal(verifyRunnerToken(token, 'zzzz'), false);
    assert.equal(verifyRunnerToken(token, 'abc'), false);
  });

  it('sha256Hex is stable and matches node crypto', () => {
    assert.equal(sha256Hex('omadia'), createHash('sha256').update('omadia', 'utf8').digest('hex'));
  });
});
