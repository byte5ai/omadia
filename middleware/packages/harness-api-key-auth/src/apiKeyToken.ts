/**
 * API key: mint / hash / verify. Introduced by issue #438 inside
 * `@omadia/channel-api`, moved here unchanged by issue #439 so the kernel and
 * any plugin can share the SAME implementation (core must never import from a
 * channel plugin).
 *
 * Mirrors `middleware/src/devplatform/jobToken.ts` (the dev-runner's one-time
 * job token), the closest existing precedent for a bearer credential this
 * codebase hashes at rest and verifies in constant time. The plaintext exists
 * exactly once — at creation time, returned to the operator — and is never
 * persisted. Only its sha256 hex lands in the vault (`apiKeyStore.ts`).
 * Verification hashes the presented token and compares digests with
 * `crypto.timingSafeEqual`, so a wrong key cannot be distinguished by timing.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Every minted key carries this prefix so it is greppable in logs/incidents
 *  and visually distinct from other omadia tokens (e.g. `djr_`). */
export const API_KEY_PREFIX = 'omk_';

/** 32 random bytes → 43 base64url chars; with the prefix, a 47-char key. */
const API_KEY_RANDOM_BYTES = 32;

export interface MintedApiKey {
  /** Plaintext — hand to the operator once, never store, never log. */
  token: string;
  /** sha256 hex — the ONLY thing that goes into the vault. */
  hash: string;
}

/** sha256 hex of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Mint a fresh API key and its stored hash. */
export function mintApiKey(): MintedApiKey {
  const token = API_KEY_PREFIX + randomBytes(API_KEY_RANDOM_BYTES).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

/**
 * Constant-time check of a presented key against a stored sha256 hash. Both
 * operands are sha256 digests (fixed 32 bytes) once decoded, so `expected`
 * and `actual` always match in length for a well-formed stored hash;
 * `timingSafeEqual` never throws for that case. A malformed/empty stored
 * hash, or a non-string input, is a plain `false` rather than an exception —
 * the length check is a guard, not a shortcut that skips comparing the
 * secret material itself.
 */
export function verifyApiKey(token: string, storedHash: string | null | undefined): boolean {
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
  // without ever calling timingSafeEqual on mismatched-length buffers (throws).
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}
