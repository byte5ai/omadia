import crypto from 'node:crypto';
import path from 'node:path';

import type { EncryptedSecretMaterial } from '@omadia/channel-sdk';

import { resolveMasterKey, type MasterKeyResult } from '../secrets/fileVault.js';

/**
 * #578 Phase 1 — encryption for the credential keychain.
 *
 * Same envelope and cipher as the existing secret vault (`fileVault.ts`):
 * AES-256-GCM, random 12-byte IV per encryption, 16-byte GCM auth tag. This
 * file reuses `resolveMasterKey` from the vault rather than re-implementing
 * key resolution, but resolves it under a DIFFERENT env var
 * (`CREDENTIAL_KEYCHAIN_KEY`, not `VAULT_KEY`) and a different dev-key file.
 *
 * The two are deliberately different keys even though they share code: the
 * provider-secret vault and the credential keychain are different trust
 * domains (agent-scoped API keys the *plugin* owns, vs. principal-owned or
 * org-service credentials the *broker* mediates). A single compromised key
 * should not unlock both. Sharing `resolveMasterKey` is safe because it is
 * pure key-material resolution with no state tied to which vault calls it.
 */

const DEV_KEY_FILENAME = '.dev-credential-keychain.key';

export async function resolveCredentialMasterKey(
  dataDir: string,
  productionMode = false,
): Promise<MasterKeyResult> {
  const devKeyPath = path.join(dataDir, DEV_KEY_FILENAME);
  return resolveMasterKey(process.env.CREDENTIAL_KEYCHAIN_KEY, devKeyPath, productionMode);
}

/** Encrypts `plaintext` with `key` (32 bytes) into the shared envelope shape. */
export function sealSecret(plaintext: string, key: Buffer): EncryptedSecretMaterial {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypts material sealed by {@link sealSecret}. Throws on a bad key or a
 * tampered ciphertext (GCM auth-tag mismatch) — never returns a partial or
 * garbled result, which matters here because a silently-wrong secret would be
 * stamped onto an outbound request by the broker (phase 2) rather than
 * surfaced as a decryption failure.
 */
export function unsealSecret(material: EncryptedSecretMaterial, key: Buffer): string {
  const iv = Buffer.from(material.iv, 'base64');
  const tag = Buffer.from(material.tag, 'base64');
  const ciphertext = Buffer.from(material.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
