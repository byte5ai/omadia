import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { secretsFile } from './paths';
import { log } from './log';

/**
 * Secret custody for the desktop app.
 *
 * Two kinds of secrets live here:
 *   1. The kernel vault master key (`VAULT_KEY`). The kernel encrypts its own
 *      secrets store with this 32-byte key and, in production mode, refuses to
 *      boot without it. We generate it once and hand it back to the kernel as an
 *      env var on every spawn.
 *   2. Provider API keys (e.g. ANTHROPIC_API_KEY) entered in the onboarding
 *      wizard, so first boot is useful and later boots don't re-prompt.
 *
 * Everything is encrypted at rest with Electron `safeStorage`, which is backed by
 * the OS keychain/credential store (Keychain on macOS, DPAPI on Windows). This is
 * what lets us avoid the kernel's dev fallback that writes a plaintext-equivalent
 * key next to the data — the exact weakness the compose file warns about.
 */

interface SecretsBlob {
  /** base64 of 32 random bytes — the kernel's VAULT_KEY value. */
  vaultKey: string;
  /** provider key id → value, e.g. { ANTHROPIC_API_KEY: "sk-..." }. */
  providerKeys: Record<string, string>;
}

let cache: SecretsBlob | null = null;

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function load(): SecretsBlob {
  if (cache) return cache;
  const file = secretsFile();
  if (fs.existsSync(file)) {
    try {
      const cipher = fs.readFileSync(file);
      const plain = encryptionAvailable()
        ? safeStorage.decryptString(cipher)
        : cipher.toString('utf8');
      cache = JSON.parse(plain) as SecretsBlob;
      return cache;
    } catch (err) {
      log.error(`[secrets] failed to read secrets file: ${String(err)}`);
      // Fall through and regenerate — a corrupt secrets file must not brick boot,
      // though it does mean existing vault entries become unrecoverable.
    }
  }
  cache = { vaultKey: generateVaultKey(), providerKeys: {} };
  persist();
  return cache;
}

function persist(): void {
  if (!cache) return;
  const json = JSON.stringify(cache);
  if (!encryptionAvailable()) {
    // Fail closed in a real (packaged) install: the onboarding UI promises the
    // key is encrypted in the OS keychain, so we must not silently downgrade to
    // plaintext. In dev we allow it with a loud warning to keep iteration cheap.
    if (app.isPackaged) {
      throw new Error(
        'OS-backed encryption (keychain/credential store) is unavailable, so ' +
          'omadia will not store your secrets in plaintext. On Linux, configure ' +
          'a Secret Service keyring (e.g. gnome-keyring/libsecret) and retry.',
      );
    }
    log.warn('[secrets] OS encryption unavailable — storing secrets UNENCRYPTED (dev only).');
    fs.writeFileSync(secretsFile(), Buffer.from(json, 'utf8'), { mode: 0o600 });
    return;
  }
  fs.writeFileSync(secretsFile(), safeStorage.encryptString(json), { mode: 0o600 });
}

function generateVaultKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

/** The kernel's VAULT_KEY (base64, decodes to 32 bytes). Generated on first call. */
export function vaultKey(): string {
  return load().vaultKey;
}

/** Store a provider API key (encrypted). */
export function setProviderKey(id: string, value: string): void {
  const blob = load();
  blob.providerKeys[id] = value;
  persist();
}

/** Read a provider API key, or undefined. */
export function getProviderKey(id: string): string | undefined {
  return load().providerKeys[id];
}

/** All provider keys, for injecting into the kernel env on spawn. */
export function allProviderKeys(): Record<string, string> {
  return { ...load().providerKeys };
}

/** Export the vault master key as a recovery string the user can save. */
export function exportRecoveryKey(): string {
  return load().vaultKey;
}

export function isEncryptionAvailable(): boolean {
  return encryptionAvailable();
}
