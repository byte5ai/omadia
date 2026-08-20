import crypto from 'node:crypto';

import type { SecretVault } from '../secrets/vault.js';

/**
 * #778 W1 — the HMAC key `signSkillManifest`/`promoteSkillOwnerScope`
 * (#577 P1/P3) sign a skill's tamper-evident manifest with.
 *
 * Mirrors `auth/sessionSigningKey.ts` exactly: generate on first call,
 * persist in the vault so every subsequent boot (and any replacement process
 * reading the same vault) re-signs with the SAME key — a rotation here
 * invalidates every previously-issued manifest signature, the same
 * "log everyone out" trade-off `resolveSessionSigningKey` documents for
 * cookies.
 *
 * A dedicated vault scope (`core:skills`), not `core:auth` — this key signs
 * data-integrity artefacts, not authentication tokens. Different trust
 * domain, same reasoning `credentials/crypto.ts` gives for keeping the
 * credential-keychain master key separate from the provider-secret vault's:
 * a single compromised key should not unlock both.
 */
export const CORE_SKILLS_AGENT_ID = 'core:skills';

const SIGNING_KEY_VAULT_KEY = 'skill_manifest_signing_key';
const KEY_BYTES = 32;

export async function resolveSkillManifestSigningKey(
  vault: SecretVault,
): Promise<string> {
  const existing = await vault.get(CORE_SKILLS_AGENT_ID, SIGNING_KEY_VAULT_KEY);
  if (existing) return existing;
  const fresh = crypto.randomBytes(KEY_BYTES).toString('hex');
  await vault.set(CORE_SKILLS_AGENT_ID, SIGNING_KEY_VAULT_KEY, fresh);
  return fresh;
}
