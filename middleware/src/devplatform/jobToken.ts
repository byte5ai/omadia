/**
 * Epic #470 W0 — one-time runner token: mint / hash / verify.
 *
 * A job's runner token is the ONLY credential the phone-home router accepts
 * (spec §4). Format: `djr_` + 32 random bytes, base64url. The plaintext exists
 * exactly once — at provision time, handed to the backend as an env var — and
 * is never persisted. Only its sha256 hex lands in `dev_jobs.runner_token_hash`.
 * Verification hashes the presented token and compares the two digests with
 * `crypto.timingSafeEqual`, so a wrong token cannot be distinguished by timing.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Every minted token carries this prefix so it is greppable in logs/incidents. */
export const RUNNER_TOKEN_PREFIX = 'djr_';

/** 32 random bytes → 43 base64url chars; with the prefix, a 47-char token. */
const RUNNER_TOKEN_RANDOM_BYTES = 32;

export interface MintedRunnerToken {
  /** Plaintext — hand to the backend once, never store, never log. */
  token: string;
  /** sha256 hex — the ONLY thing that goes to the DB. */
  hash: string;
}

/** sha256 hex of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Mint a fresh one-time runner token and its stored hash. */
export function mintRunnerToken(): MintedRunnerToken {
  const token = RUNNER_TOKEN_PREFIX + randomBytes(RUNNER_TOKEN_RANDOM_BYTES).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

/** The value to store in `dev_jobs.runner_token_hash` for a given plaintext. */
export function hashRunnerToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Constant-time check of a presented token against a stored sha256 hash.
 *
 * Both operands are sha256 digests (fixed 32 bytes), so lengths always match
 * and `timingSafeEqual` never throws for a well-formed stored hash. The guards
 * make a malformed/empty stored hash — or a non-string input — a plain `false`
 * rather than an exception, satisfying "must not throw on differing lengths".
 */
export function verifyRunnerToken(token: string, storedHash: string | null | undefined): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;

  const actual = Buffer.from(sha256Hex(token), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  // Non-hex / truncated stored hash decodes to a different length — reject
  // without ever calling timingSafeEqual on mismatched buffers (which throws).
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}
