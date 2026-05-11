import crypto from 'node:crypto';

import type { SecretVault } from '../secrets/vault.js';
import { CORE_AUTH_AGENT_ID } from './coreAuthScope.js';

const SIGNING_KEY_VAULT_KEY = 'session_signing_key';
const KEY_BYTES = 64;

/**
 * Load the symmetric key used to sign session JWTs. Generates on first call
 * and persists in the core-auth vault scope so the same machine (and any
 * replacement reading the same vault) keeps minting verifiable cookies.
 *
 * Rotating the key = every outstanding session is invalidated. That is the
 * only supported "log out everyone" lever; no separate key-version field.
 */
export async function resolveSessionSigningKey(
  vault: SecretVault,
): Promise<Uint8Array> {
  const existing = await vault.get(CORE_AUTH_AGENT_ID, SIGNING_KEY_VAULT_KEY);
  if (existing) {
    const buf = Buffer.from(existing, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `core:auth/session_signing_key has unexpected length ${buf.length} (want ${KEY_BYTES})`,
      );
    }
    return new Uint8Array(buf);
  }
  const fresh = crypto.randomBytes(KEY_BYTES);
  await vault.set(
    CORE_AUTH_AGENT_ID,
    SIGNING_KEY_VAULT_KEY,
    fresh.toString('base64'),
  );
  return new Uint8Array(fresh);
}
