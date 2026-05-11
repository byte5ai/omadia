import * as argon2 from 'argon2';

/**
 * Centralised password hashing. Picks argon2id with OWASP-2024-recommended
 * parameters (memory cost 19 MiB, time cost 2, parallelism 1) — strong
 * enough for an admin-tier account-store while keeping CPU per login
 * sub-50ms on a typical Fly shared-cpu-2x machine.
 *
 * Pinning the params here means a future bump (e.g. memoryCost up to 64 MiB
 * once we have more headroom) is a one-line change and old hashes still
 * verify because argon2 encodes its parameters into the hash string.
 *
 * The wrapper exists so the rest of the codebase (LocalPasswordProvider,
 * tests, the bootstrap seeder) never imports the underlying lib directly —
 * makes a future swap to scrypt/bcrypt or a re-tuning trivial.
 */

const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('hashPassword: plaintext must be a non-empty string');
  }
  return await argon2.hash(plaintext, HASH_OPTIONS);
}

/**
 * Verify a plaintext password against a stored argon2 hash. Returns false
 * (not throw) on every mismatch / malformed-hash path so the caller can
 * keep its error semantics consistent ("wrong credentials" → 401 always).
 */
export async function verifyPassword(
  hash: string,
  plaintext: string,
): Promise<boolean> {
  if (typeof hash !== 'string' || hash.length === 0) return false;
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Helper for tests + admin password-reset: returns true if a stored hash
 * was generated with weaker parameters than the current `HASH_OPTIONS` and
 * should be re-hashed on next successful login. Not used in V1 (we ship
 * one parameter set), wired for V1.x rotation.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, HASH_OPTIONS);
  } catch {
    return false;
  }
}
