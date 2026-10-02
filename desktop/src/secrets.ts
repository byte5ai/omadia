import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { secretsFile, snapshotDir } from './paths';
import { log } from './log';
import type { EmbeddedDbCredentials, SecretsBlob, SecretsCodec, SecretsIo } from './secretsBlob';
import { createSecretsStore } from './secretsStore';

/**
 * Secret custody for the desktop app.
 *
 * Four kinds of secrets live here:
 *   1. The kernel vault master key (`VAULT_KEY`). The kernel encrypts its own
 *      secrets store with this 32-byte key and, in production mode, refuses to
 *      boot without it. We generate it once and hand it back to the kernel as an
 *      env var on every spawn.
 *   2. The credential keychain key (`CREDENTIAL_KEYCHAIN_KEY`), a separate
 *      trust domain the kernel also requires in production.
 *   3. Provider API keys (e.g. ANTHROPIC_API_KEY) entered in the onboarding
 *      wizard, so first boot is useful and later boots don't re-prompt.
 *   4. The embedded Postgres passwords (`embeddedDbAuth.ts`): the bootstrap
 *      superuser's, which never leaves this process, and the restricted kernel
 *      role's, which reaches the kernel only inside its DATABASE_URL.
 *
 * Everything is encrypted at rest with Electron `safeStorage`, which is backed by
 * the OS keychain/credential store (Keychain on macOS, DPAPI on Windows). This is
 * what lets us avoid the kernel's dev fallback that writes a plaintext-equivalent
 * key next to the data — the exact weakness the compose file warns about.
 *
 * This file is only the Electron adapter. The rules live in Electron-free
 * modules so they can be asserted: `secretsBlob.ts` (new keys only for a
 * missing file; an unreadable file throws `SecretsUnreadableError` and is never
 * replaced; every rewrite is backup + temp file + rename) and `secretsStore.ts`
 * (write before cache; the cache follows the data dir).
 */

/** The real filesystem behind the secrets modules' port. */
const realSecretsIo: SecretsIo = {
  readFile: (file) => fs.readFileSync(file),
  writeFile: (file, data, mode) => {
    // Exclusive create, then flushed before the rename makes it the live file:
    // a rename that outlives a crash must not point at unwritten blocks.
    const fd = fs.openSync(file, 'wx', mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  copyFile: (from, to, mode) => {
    fs.copyFileSync(from, to);
    // Explicit, not inherited: the backup holds the same secrets as the file.
    fs.chmodSync(to, mode);
  },
  remove: (file) => fs.rmSync(file, { force: true }),
  exists: (file) => fs.existsSync(file),
  listDir: (dir) => fs.readdirSync(dir),
  info: (message) => log.info(`[secrets] ${message}`),
  warn: (message) => log.warn(`[secrets] ${message}`),
  error: (message) => log.error(`[secrets] ${message}`),
};

/**
 * `safeStorage`, looked up on every call rather than destructured: the test
 * fake swaps these methods on the object this module imported.
 */
const safeStorageCodec: SecretsCodec = {
  encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
};

function generateVaultKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

const store = createSecretsStore({
  io: realSecretsIo,
  codec: safeStorageCodec,
  file: secretsFile,
  // Fail closed in a packaged install; plaintext with a loud warning in dev.
  allowPlaintext: !app.isPackaged,
  generateKey: generateVaultKey,
  snapshotDir,
});

/** The kernel's VAULT_KEY (base64, decodes to 32 bytes). Generated on first call. */
export function vaultKey(): string {
  return store.load().vaultKey;
}

function withCredentialKeychainKey(current: SecretsBlob): SecretsBlob {
  return current.credentialKeychainKey
    ? current
    : { ...current, credentialKeychainKey: generateVaultKey() };
}

/**
 * The kernel's CREDENTIAL_KEYCHAIN_KEY. The credential keychain (#578)
 * fail-hards in production without it — v0.115.0 shipped with the kernel
 * reading it and the supervisor not passing it, which killed every FRESH
 * install at first boot ("kernel did not become healthy"). A fresh blob is
 * created with it; a blob from before the field existed gets one here, once.
 */
export function credentialKeychainKey(): string {
  const key =
    store.load().credentialKeychainKey ??
    // The value that was persisted, not the stale pre-migration blob's.
    store.update(withCredentialKeychainKey).credentialKeychainKey;
  if (!key) throw new Error('[secrets] credential keychain key missing after migration');
  return key;
}

/** 32 random bytes as hex: URL-safe in a DSN and needs no quoting anywhere. */
function generateDbPassword(): string {
  return crypto.randomBytes(32).toString('hex');
}

function withEmbeddedDbCredentials(current: SecretsBlob): SecretsBlob {
  return current.embeddedDb
    ? current
    : {
        ...current,
        embeddedDb: { superuserPassword: generateDbPassword(), kernelPassword: generateDbPassword() },
      };
}

function sameCredentials(a: EmbeddedDbCredentials | undefined, b: EmbeddedDbCredentials): boolean {
  return a?.superuserPassword === b.superuserPassword && a.kernelPassword === b.kernelPassword;
}

/**
 * The embedded Postgres passwords, created on first use (a fresh install and a
 * blob from before they existed take the same path).
 *
 * New ones are read back from the file before they are returned: the caller
 * provisions the cluster with them next, and a password the cluster holds but
 * `secrets.enc` does not would lock the shell out of its own database. An
 * unreadable file throws `SecretsUnreadableError` like every other accessor.
 */
export function embeddedDbCredentials(): EmbeddedDbCredentials {
  const loaded = store.load().embeddedDb;
  if (loaded) return { ...loaded };

  const written = store.update(withEmbeddedDbCredentials).embeddedDb;
  // Until the read-back succeeds, the cache holds values the file may not:
  // on any failure drop it, so a retry starts from the file instead of
  // handing them out.
  let durable: EmbeddedDbCredentials | undefined;
  try {
    durable = store.reread()?.embeddedDb;
  } catch (err) {
    store.reset();
    throw err;
  }
  if (durable === undefined || !sameCredentials(written, durable)) {
    store.reset();
    throw new Error(
      '[secrets] the embedded database credentials did not read back from secrets.enc; ' +
        'the database was not provisioned with them',
    );
  }
  return { ...durable };
}

/** Store a provider API key (encrypted). */
export function setProviderKey(id: string, value: string): void {
  store.update((current) => ({
    ...current,
    providerKeys: { ...current.providerKeys, [id]: value },
  }));
}

/** Read a provider API key, or undefined. */
export function getProviderKey(id: string): string | undefined {
  return store.load().providerKeys[id];
}

/** All provider keys, for injecting into the kernel env on spawn. */
export function allProviderKeys(): Record<string, string> {
  return { ...store.load().providerKeys };
}

/** Export the vault master key as a recovery string the user can save. */
export function exportRecoveryKey(): string {
  return store.load().vaultKey;
}

export function isEncryptionAvailable(): boolean {
  return safeStorageCodec.encryptionAvailable();
}

/** Forget the cached blob, so a test starts from what is on disk. */
export function __resetSecretsCacheForTests(): void {
  store.reset();
}
